from __future__ import annotations

import logging
import time
from functools import lru_cache
from typing import Any, Literal

from fastapi import BackgroundTasks, Body, Depends, FastAPI, HTTPException, Query, status

from .config import Settings, get_settings
from .extract import build_call, build_lead, merge_call, merge_lead
from .repository import LeadRepository, SupabaseLeadRepository
from .security import verify_api_key, verify_vapi_webhook
from .vapi_client import fetch_call

log = logging.getLogger("wow")
logging.basicConfig(level=logging.INFO)

app = FastAPI(title="WOW Concierge backend", version="1.0.0")

LeadStatus = Literal["qualified", "nurture", "not_qualified", "not_interested", "incomplete"]
BACKFILL_DELAYS_SECONDS = (5, 15, 30)


@lru_cache
def _supabase_repo() -> SupabaseLeadRepository:
    s = get_settings()
    return SupabaseLeadRepository(s.supabase_url, s.supabase_service_role_key)


def get_repo(settings: Settings = Depends(get_settings)) -> LeadRepository:
    if not (settings.supabase_url and settings.supabase_service_role_key):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Supabase is not configured")
    return _supabase_repo()


def store(repo: LeadRepository, call_id: str, source: dict) -> dict:
    """Writes the call and lead rows. Safe to run any number of times for the same call."""
    call_row = merge_call(repo.get_call(call_id), build_call(call_id, source))
    repo.upsert_call(call_row)  # parent row first: leads references calls
    lead_row = merge_lead(repo.get_lead(call_id), build_lead(call_id, source))
    repo.upsert_lead(lead_row)
    return lead_row


def backfill(repo: LeadRepository, call_id: str, private_key: str) -> None:
    """Vapi can send the end-of-call report before its structured output is finished.
    Re-read the call a few times and fill in whatever arrives."""
    for delay in BACKFILL_DELAYS_SECONDS:
        time.sleep(delay)
        call = fetch_call(call_id, private_key)
        if not call:
            continue
        try:
            lead = store(repo, call_id, call)
        except Exception:  # noqa: BLE001 - background job: log and try again
            log.exception("Backfill failed for call %s", call_id)
            continue
        if lead["lead_status"] != "incomplete":
            log.info("Backfilled call %s as %s", call_id, lead["lead_status"])
            return


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/webhooks/vapi", dependencies=[Depends(verify_vapi_webhook)])
def vapi_webhook(
    background: BackgroundTasks,
    payload: dict[str, Any] = Body(...),
    repo: LeadRepository = Depends(get_repo),
    settings: Settings = Depends(get_settings),
) -> dict:
    message = payload.get("message")
    if not isinstance(message, dict):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Body must contain a 'message' object")

    # If the assistant has this server as its Server URL, Vapi routes tool calls here too
    # (a tool without its own URL falls back to the assistant's). Answer them so the
    # assistant is never left waiting; the browser still gets them for the live tracker.
    if message.get("type") == "tool-calls":
        calls = message.get("toolCallList") or []
        return {
            "results": [
                {"toolCallId": tc.get("id"), "result": "Recorded."}
                for tc in calls
                if isinstance(tc, dict) and tc.get("id")
            ]
        }

    # Vapi sends many event types to the same URL. Only the final report is stored;
    # everything else is acknowledged so Vapi does not treat it as a failure.
    if message.get("type") != "end-of-call-report":
        return {"status": "ignored", "type": message.get("type")}

    call = message.get("call") if isinstance(message.get("call"), dict) else {}
    call_id = call.get("id")
    if not isinstance(call_id, str) or not call_id:
        # Without a call ID there is nothing to deduplicate on. Acknowledge and log.
        log.warning("end-of-call-report without call.id; skipped")
        return {"status": "skipped", "reason": "missing call id"}

    if settings.vapi_assistant_id and call.get("assistantId") not in (None, settings.vapi_assistant_id):
        return {"status": "ignored", "reason": "different assistant"}

    try:
        lead = store(repo, call_id, message)
    except Exception as exc:  # noqa: BLE001
        # A 5xx tells the sender the delivery failed, so a retry can succeed later.
        log.exception("Could not store call %s", call_id)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Could not store the call") from exc

    if lead["lead_status"] == "incomplete" and settings.vapi_private_key:
        background.add_task(backfill, repo, call_id, settings.vapi_private_key)

    return {
        "status": "stored",
        "call_id": call_id,
        "lead_status": lead["lead_status"],
        "missing_fields": lead["missing_fields"],
    }


@app.post("/calls/{call_id}/sync", dependencies=[Depends(verify_api_key)])
def sync_call(
    call_id: str,
    repo: LeadRepository = Depends(get_repo),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Pulls a finished call from Vapi's API and saves it. The web app calls this when a
    call ends, so calls are stored even when Vapi webhooks can't reach this server.
    Safe to call repeatedly: it upserts on the call ID and never erases stored data."""
    if not settings.vapi_private_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "VAPI_PRIVATE_KEY is not set on the backend")
    call = fetch_call(call_id, settings.vapi_private_key)
    if not call:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Vapi has no call with this ID, or rejected VAPI_PRIVATE_KEY")
    if settings.vapi_assistant_id and call.get("assistantId") not in (None, settings.vapi_assistant_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Call belongs to a different assistant")
    try:
        lead = store(repo, call_id, call)
    except Exception as exc:  # noqa: BLE001
        log.exception("Could not store call %s", call_id)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Could not save to Supabase; check the backend log") from exc
    saved_call = repo.get_call(call_id) or {}
    return {
        "status": "stored",
        "call_id": call_id,
        "call_status": call.get("status"),
        "ended_reason": saved_call.get("ended_reason"),
        "duration_seconds": saved_call.get("duration_seconds"),
        "summary": saved_call.get("summary"),
        "lead": lead,
    }


@app.get("/leads", dependencies=[Depends(verify_api_key)])
def list_leads(
    lead_status: LeadStatus | None = None,
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    repo: LeadRepository = Depends(get_repo),
) -> dict:
    leads = repo.list_leads(lead_status, limit, offset)
    return {"count": len(leads), "limit": limit, "offset": offset, "leads": leads}


@app.get("/leads/{call_id}", dependencies=[Depends(verify_api_key)])
def get_lead(call_id: str, repo: LeadRepository = Depends(get_repo)) -> dict:
    lead = repo.get_lead_detail(call_id)
    if not lead:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No lead for this call")
    return lead
