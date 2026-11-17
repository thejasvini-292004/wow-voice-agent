import copy

import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import Settings, get_settings
from app.main import app, get_repo

SECRET = "test-webhook-secret"
API_KEY = "test-api-key"
CALL_ID = "0f0e2b6a-1111-4222-8333-444455556666"


class FakeRepo:
    """In-memory stand-in for Supabase with the same upsert-by-call-id behaviour."""

    def __init__(self):
        self.calls, self.leads, self.fail = {}, {}, False

    def get_call(self, call_id):
        return copy.deepcopy(self.calls.get(call_id))

    def get_lead(self, call_id):
        return copy.deepcopy(self.leads.get(call_id))

    def upsert_call(self, row):
        if self.fail:
            raise RuntimeError("database down")
        self.calls[row["vapi_call_id"]] = copy.deepcopy(row)

    def upsert_lead(self, row):
        self.leads[row["vapi_call_id"]] = copy.deepcopy(row)

    def list_leads(self, lead_status, limit, offset):
        rows = [r for r in self.leads.values() if not lead_status or r["lead_status"] == lead_status]
        return rows[offset : offset + limit]

    def get_lead_detail(self, call_id):
        lead = self.get_lead(call_id)
        return {**lead, "calls": self.get_call(call_id)} if lead else None


@pytest.fixture
def repo():
    return FakeRepo()


@pytest.fixture
def client(repo):
    app.dependency_overrides[get_repo] = lambda: repo
    app.dependency_overrides[get_settings] = lambda: Settings(
        _env_file=None, vapi_webhook_secret=SECRET, leads_api_key=API_KEY
    )
    yield TestClient(app)
    app.dependency_overrides.clear()


def report(structured=None, **overrides):
    message = {
        "type": "end-of-call-report",
        "endedReason": "customer-ended-call",
        "startedAt": "2026-11-16T10:00:00.000Z",
        "endedAt": "2026-11-16T10:02:40.000Z",
        "call": {"id": CALL_ID, "type": "webCall", "assistantId": "asst_1"},
        "artifact": {
            "transcript": "AI: Namaste, am I speaking at a good time?\nUser: Yes, go ahead.",
            "messages": [
                {"role": "assistant", "message": "Namaste, am I speaking at a good time?"},
                {"role": "user", "message": "Yes, go ahead."},
            ],
        },
        "analysis": {"summary": "Customer wants a weekend home and agreed to a follow-up."},
    }
    if structured is not None:
        message["artifact"]["structuredOutputs"] = {"so_1": {"name": "lead", "result": structured}}
    message.update(overrides)
    return {"message": message}


FULL = {
    "intent": "self_use",
    "geography_fit": True,
    "budget": "1.2 crore",
    "budget_fit": True,
    "timeline_fit": True,
    "objections": ["Distance from Whitefield"],
    "follow_up_interest": True,
    "callback_preference": "Saturday morning",
}
AUTH = {"Authorization": f"Bearer {SECRET}"}


def test_rejects_missing_and_wrong_secret(client):
    assert client.post("/webhooks/vapi", json=report(FULL)).status_code == 401
    assert client.post("/webhooks/vapi", json=report(FULL), headers={"X-Vapi-Secret": "nope"}).status_code == 401


def test_accepts_bearer_and_legacy_header(client):
    assert client.post("/webhooks/vapi", json=report(FULL), headers=AUTH).status_code == 200
    assert client.post("/webhooks/vapi", json=report(FULL), headers={"X-Vapi-Secret": SECRET}).status_code == 200


def test_unset_secret_never_means_open(repo):
    app.dependency_overrides[get_repo] = lambda: repo
    app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None)
    res = TestClient(app).post("/webhooks/vapi", json=report(FULL))
    app.dependency_overrides.clear()
    assert res.status_code == 503 and not repo.leads


def test_stores_transcript_and_all_lead_fields(client, repo):
    res = client.post("/webhooks/vapi", json=report(FULL), headers=AUTH)
    assert res.json()["lead_status"] == "qualified"
    call, lead = repo.calls[CALL_ID], repo.leads[CALL_ID]
    assert "Namaste" in call["transcript"] and len(call["messages"]) == 2
    assert call["duration_seconds"] == 160 and call["ended_reason"] == "customer-ended-call"
    for field, value in FULL.items():
        assert lead[field] == value
    assert lead["data_complete"] is True and lead["missing_fields"] == []


def test_other_event_types_are_acknowledged_not_stored(client, repo):
    res = client.post("/webhooks/vapi", json={"message": {"type": "status-update", "status": "in-progress"}}, headers=AUTH)
    assert res.status_code == 200 and res.json()["status"] == "ignored" and not repo.calls


def test_retried_webhook_creates_one_record(client, repo):
    for _ in range(3):
        assert client.post("/webhooks/vapi", json=report(FULL), headers=AUTH).status_code == 200
    assert len(repo.calls) == 1 and len(repo.leads) == 1


def test_late_retry_without_data_does_not_erase_stored_lead(client, repo):
    client.post("/webhooks/vapi", json=report(FULL), headers=AUTH)
    client.post("/webhooks/vapi", json=report(None, analysis={}), headers=AUTH)
    lead = repo.leads[CALL_ID]
    assert lead["budget"] == "1.2 crore" and lead["lead_status"] == "qualified"
    assert repo.calls[CALL_ID]["summary"].startswith("Customer wants")


def test_early_hangup_with_no_customer_data(client, repo):
    bare = {"message": {"type": "end-of-call-report", "call": {"id": CALL_ID}}}
    res = client.post("/webhooks/vapi", json=bare, headers=AUTH)
    assert res.status_code == 200 and res.json()["lead_status"] == "incomplete"
    lead = repo.leads[CALL_ID]
    assert lead["intent"] is None and lead["objections"] == [] and lead["data_complete"] is False
    assert "budget_fit" in lead["missing_fields"]
    assert repo.calls[CALL_ID]["transcript"] is None


def test_messy_values_are_normalised(client, repo):
    messy = {"Intent": "Investment purposes", "budgetFit": "no", "geography_fit": "yes",
             "budget": "unknown", "objections": "Too far; Price is high", "follow_up_interest": "maybe"}
    client.post("/webhooks/vapi", json=report(messy), headers=AUTH)
    lead = repo.leads[CALL_ID]
    assert lead["intent"] == "investment" and lead["budget_fit"] is False and lead["geography_fit"] is True
    assert lead["budget"] is None and lead["follow_up_interest"] is None
    assert lead["objections"] == ["Too far", "Price is high"]
    assert lead["lead_status"] == "not_qualified"


def test_legacy_structured_data_location(client, repo):
    client.post("/webhooks/vapi", json=report(None, analysis={"structuredData": {"follow_up_interest": False}}), headers=AUTH)
    assert repo.leads[CALL_ID]["lead_status"] == "not_interested"


def test_missing_call_id_and_bad_body(client, repo):
    res = client.post("/webhooks/vapi", json={"message": {"type": "end-of-call-report"}}, headers=AUTH)
    assert res.status_code == 200 and res.json()["status"] == "skipped" and not repo.calls
    assert client.post("/webhooks/vapi", json={"hello": "world"}, headers=AUTH).status_code == 400
    assert client.post("/webhooks/vapi", content="not json", headers={**AUTH, "Content-Type": "application/json"}).status_code == 422


def test_database_failure_returns_503_so_sender_can_retry(client, repo):
    repo.fail = True
    assert client.post("/webhooks/vapi", json=report(FULL), headers=AUTH).status_code == 503
    repo.fail = False
    assert client.post("/webhooks/vapi", json=report(FULL), headers=AUTH).status_code == 200
    assert len(repo.leads) == 1


def test_backfill_fills_in_late_structured_output(client, repo, monkeypatch):
    client.post("/webhooks/vapi", json=report(None), headers=AUTH)
    assert repo.leads[CALL_ID]["lead_status"] == "incomplete"
    late_call = {"id": CALL_ID, "artifact": {"structuredOutputs": {"so_1": {"name": "lead", "result": FULL}}}}
    monkeypatch.setattr(main, "fetch_call", lambda call_id, key: late_call)
    monkeypatch.setattr(main.time, "sleep", lambda s: None)
    main.backfill(repo, CALL_ID, "private-key")
    assert repo.leads[CALL_ID]["lead_status"] == "qualified"
    assert "Namaste" in repo.calls[CALL_ID]["transcript"]  # earlier data kept


def test_leads_endpoints_require_key_and_return_summaries(client, repo):
    client.post("/webhooks/vapi", json=report(FULL), headers=AUTH)
    assert client.get("/leads").status_code == 401
    key = {"X-API-Key": API_KEY}
    listing = client.get("/leads", headers=key).json()
    assert listing["count"] == 1 and listing["leads"][0]["lead_status"] == "qualified"
    assert client.get("/leads?lead_status=nurture", headers=key).json()["count"] == 0
    assert client.get("/leads?lead_status=bogus", headers=key).status_code == 422
    detail = client.get(f"/leads/{CALL_ID}", headers=key).json()
    assert "Namaste" in detail["calls"]["transcript"]
    assert client.get("/leads/unknown", headers=key).status_code == 404


# ---- Added with the storage fix ----------------------------------------------------

def vapi_call(result=None, messages=None, status="ended"):
    """A call record as GET https://api.vapi.ai/call/{id} returns it."""
    call = {
        "id": CALL_ID,
        "assistantId": "asst_1",
        "status": status,
        "endedReason": "customer-ended-call",
        "startedAt": "2026-11-17T09:00:00Z",
        "endedAt": "2026-11-17T09:01:34Z",
        "artifact": {"transcript": "AI: Namaste.\nUser: Hello.", "messages": messages or []},
    }
    if result is not None:
        call["artifact"]["structuredOutputs"] = {"abc": {"name": "wow_lead_summary", "result": result}}
    return call


NEW_SCHEMA_RESULT = {
    "summary": "Investor from Hyderabad, budget 1.5 crore, wants a Saturday callback.",
    "intent": "investment",
    "geography_fit": "yes",
    "budget": "1.5 crore",
    "budget_fit": "yes",
    "timeline_fit": "unknown",
    "objections": [],
    "follow_up_interest": "yes",
    "callback_preference": "Saturday morning",
}
KEY = {"X-API-Key": API_KEY}


def settings_with_vapi():
    return Settings(_env_file=None, vapi_webhook_secret=SECRET, leads_api_key=API_KEY, vapi_private_key="pk")


def test_sync_pulls_call_from_vapi_and_stores_it(client, repo, monkeypatch):
    app.dependency_overrides[get_settings] = settings_with_vapi
    monkeypatch.setattr(main, "fetch_call", lambda cid, key: vapi_call(NEW_SCHEMA_RESULT))
    res = client.post(f"/calls/{CALL_ID}/sync", headers=KEY)
    assert res.status_code == 200
    body = res.json()
    assert body["call_status"] == "ended" and body["duration_seconds"] == 94
    assert body["summary"].startswith("Investor from Hyderabad")
    assert body["lead"]["intent"] == "investment" and body["lead"]["timeline_fit"] is None
    assert body["lead"]["lead_status"] == "nurture"  # timeline unknown
    assert repo.calls[CALL_ID]["summary"].startswith("Investor") and len(repo.leads) == 1
    # Repeated polling from the web app keeps one record.
    client.post(f"/calls/{CALL_ID}/sync", headers=KEY)
    assert len(repo.leads) == 1


def test_sync_needs_api_key_and_private_key(client, monkeypatch):
    assert client.post(f"/calls/{CALL_ID}/sync").status_code == 401
    assert client.post(f"/calls/{CALL_ID}/sync", headers=KEY).status_code == 503  # no VAPI_PRIVATE_KEY
    app.dependency_overrides[get_settings] = settings_with_vapi
    monkeypatch.setattr(main, "fetch_call", lambda cid, key: None)
    assert client.post(f"/calls/{CALL_ID}/sync", headers=KEY).status_code == 404


def test_tool_calls_sent_to_webhook_are_answered(client, repo):
    msg = {"message": {"type": "tool-calls", "toolCallList": [
        {"id": "tc_1", "function": {"name": "update_qualification", "arguments": {"checkpoint": "budget"}}}]}}
    res = client.post("/webhooks/vapi", json=msg, headers=AUTH)
    assert res.json() == {"results": [{"toolCallId": "tc_1", "result": "Recorded."}]}
    assert not repo.calls


def test_lead_filled_from_live_tool_calls_when_summary_missing(client, repo, monkeypatch):
    messages = [
        {"role": "tool_calls", "toolCalls": [{"id": "1", "type": "function", "function": {
            "name": "update_qualification",
            "arguments": '{"checkpoint":"intent","status":"confirmed","value":"Weekend home for family"}'}}]},
        {"role": "tool_calls", "toolCalls": [{"id": "2", "type": "function", "function": {
            "name": "update_qualification",
            "arguments": {"checkpoint": "budget", "status": "confirmed", "value": "Around 1.2 crore"}}}]},
        {"role": "tool_calls", "toolCalls": [{"id": "3", "type": "function", "function": {
            "name": "update_qualification",
            "arguments": {"checkpoint": "geography", "status": "concern", "value": "Feels far from Whitefield"}}}]},
    ]
    app.dependency_overrides[get_settings] = settings_with_vapi
    monkeypatch.setattr(main, "fetch_call", lambda cid, key: vapi_call(None, messages))
    lead = client.post(f"/calls/{CALL_ID}/sync", headers=KEY).json()["lead"]
    assert lead["intent"] == "self_use" and lead["budget_fit"] is True and lead["budget"] == "Around 1.2 crore"
    assert lead["geography_fit"] is None
    assert lead["objections"] == ["Geography: Feels far from Whitefield"]


def test_shipped_structured_output_file_is_valid_for_vapi():
    import json
    import pathlib

    spec = json.loads((pathlib.Path(__file__).parent.parent / "vapi" / "lead_structured_output.json").read_text())

    def check(node):
        assert isinstance(node["type"], str), "Vapi accepts one type per field"
        for child in (node.get("properties") or {}).values():
            check(child)
        if node["type"] == "array":
            check(node["items"])

    check(spec["schema"])
