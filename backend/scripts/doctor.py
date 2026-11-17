"""Checks your real Vapi assistant, its last call and Supabase, and says what is missing.

Run from the backend folder:   python -m scripts.doctor
Reads VAPI_PRIVATE_KEY, VAPI_ASSISTANT_ID, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.
Read-only: it changes nothing in Vapi or Supabase.
"""

from __future__ import annotations

import json
import sys

import httpx

from app.config import get_settings
from app.extract import build_lead, collect_structured, tool_call_checkpoints

API = "https://api.vapi.ai"
problems = 0


def report(ok: bool | None, text: str, fix: str = "") -> None:
    global problems
    mark = {True: "OK  ", False: "FAIL", None: "WARN"}[ok]
    print(f"[{mark}] {text}")
    if ok is not True and fix:
        print(f"       fix: {fix}")
    if ok is False:
        problems += 1


def get(path: str, key: str) -> tuple[int, object]:
    try:
        res = httpx.get(f"{API}{path}", headers={"Authorization": f"Bearer {key}"}, timeout=15)
        return res.status_code, (res.json() if res.content else None)
    except (httpx.HTTPError, ValueError) as exc:
        return 0, str(exc)


def main() -> int:
    s = get_settings()
    print("WOW Concierge doctor\n")

    if not s.vapi_private_key:
        report(False, "VAPI_PRIVATE_KEY is empty in backend/.env", "copy the private key from Vapi > API Keys")
        return 1
    if not s.vapi_assistant_id:
        report(False, "VAPI_ASSISTANT_ID is empty in backend/.env", "copy the WOW Concierge assistant ID from Vapi")
        return 1

    code, assistant = get(f"/assistant/{s.vapi_assistant_id}", s.vapi_private_key)
    if code == 401:
        report(False, "Vapi rejected VAPI_PRIVATE_KEY", "use the PRIVATE key, not the public one")
        return 1
    if code != 200 or not isinstance(assistant, dict):
        report(False, f"Could not load the assistant (HTTP {code})", "check VAPI_ASSISTANT_ID")
        return 1
    report(True, f"Assistant found: {assistant.get('name')}")

    # 1. Live tracker: the update_qualification tool
    model = assistant.get("model") or {}
    tools = [t for t in (model.get("tools") or []) if isinstance(t, dict)]
    for tool_id in model.get("toolIds") or []:
        c, tool = get(f"/tool/{tool_id}", s.vapi_private_key)
        if c == 200 and isinstance(tool, dict):
            tools.append(tool)
    qual = next((t for t in tools if (t.get("function") or {}).get("name") == "update_qualification"), None)
    report(
        qual is not None,
        "update_qualification tool attached" if qual else "update_qualification tool is NOT attached to the assistant",
        "Tools > Create Tool > Function, paste frontend/vapi/update_qualification.tool.json, then add it to the assistant",
    )
    if qual and (qual.get("server") or {}).get("url"):
        report(None, f"The tool has its own Server URL ({qual['server']['url']})",
               "remove it, so tool calls reach the browser and the backend can answer them")

    prompt = json.dumps(model.get("messages") or [])
    report(
        "update_qualification" in prompt,
        "System prompt tells the assistant to use update_qualification"
        if "update_qualification" in prompt
        else "System prompt never mentions update_qualification, so the assistant won't call it",
        "paste the 'Recording qualification' paragraph from frontend/README.md into the prompt",
    )

    # 2. Webhook (optional now: the web app saves calls through /calls/{id}/sync)
    server_url = (assistant.get("server") or {}).get("url")
    if server_url:
        report(True, f"Assistant Server URL: {server_url}")
        if "localhost" in server_url or "127.0.0.1" in server_url:
            report(False, "Server URL points at localhost, which Vapi cannot reach", "use your ngrok https address")
    else:
        report(None, "No Server URL on the assistant: phone calls won't be saved automatically",
               "optional for web calls; for phone calls set it to https://<host>/webhooks/vapi")

    # 3. The last call
    code, calls = get(f"/call?assistantId={s.vapi_assistant_id}&limit=1", s.vapi_private_key)
    last = calls[0] if code == 200 and isinstance(calls, list) and calls else None
    if not last:
        report(None, "No calls found for this assistant yet", "make one call from the web app, then rerun")
    else:
        print(f"\nLast call {last.get('id')}: status={last.get('status')}, ended={last.get('endedReason')}")
        artifact = last.get("artifact") or {}
        report(bool(artifact.get("transcript")), "Transcript present" if artifact.get("transcript") else "No transcript on the call")
        structured = collect_structured(last)
        report(
            bool(structured),
            f"Structured output present: {', '.join(sorted(structured)) or '-'}" if structured
            else "No summary or structured output on the last call",
            "calls started from the updated web app carry their own; make a new call of at least a minute",
        )
        checkpoints = tool_call_checkpoints(last)
        report(
            bool(checkpoints),
            f"Assistant called update_qualification for: {', '.join(checkpoints)}" if checkpoints
            else "The assistant never called update_qualification on the last call",
            "attach the tool and add the prompt paragraph (see above)",
        )
        lead = build_lead(last.get("id", "x"), last)
        print(f"       lead the backend would store: status={lead['lead_status']}, missing={lead['missing_fields']}")

    # 4. Supabase
    if s.supabase_url and s.supabase_service_role_key:
        try:
            from supabase import create_client

            db = create_client(s.supabase_url, s.supabase_service_role_key)
            rows = db.table("leads").select("vapi_call_id", count="exact").limit(1).execute()
            report(True, f"Supabase connected; leads table has {rows.count} rows")
        except Exception as exc:  # noqa: BLE001
            report(False, f"Supabase error: {str(exc)[:160]}",
                   "run sql/schema.sql, and use the service_role key (not anon)")
    else:
        report(False, "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is empty", "copy them from Supabase > Project Settings > API")

    if not s.leads_api_key:
        report(False, "LEADS_API_KEY is empty", "set it, and set the same value in frontend/.env.local")

    print(f"\n{'All checks passed.' if not problems else f'{problems} problem(s) to fix.'}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
