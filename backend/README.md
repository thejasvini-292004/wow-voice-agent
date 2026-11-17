# WOW Concierge backend

FastAPI service that receives Vapi's end-of-call report, stores the transcript and the
structured lead in Supabase, and serves lead summaries.

## How calls reach this server

There are two paths. Either one stores the call; both together are safe because every write
is an upsert on Vapi's call ID.

**Pull (default, used by the web app).** When a call ends, the web app's server route calls
`POST /calls/{call_id}/sync`. This server reads the call from `https://api.vapi.ai/call/{id}` with
`VAPI_PRIVATE_KEY` and saves it. No public URL, ngrok or webhook setup is needed.

**Push (optional, needed for phone calls).** Set the assistant's Server URL to
`https://<public-host>/webhooks/vapi` with a Bearer Token credential equal to
`VAPI_WEBHOOK_SECRET`. Vapi then sends `end-of-call-report` when any call ends. If the
assistant routes `tool-calls` here, the server answers them so the assistant never waits.

Where the lead fields come from, in order: the `wow_lead_summary` structured output the web
app attaches to each call; any structured output attached in the dashboard
(`vapi/lead_structured_output.json`); and, for gaps, the assistant's live
`update_qualification` tool calls in the call log.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # fill in the values
pytest -q                       # 19 tests, no network or database needed
python -m scripts.doctor        # checks your real Vapi assistant, last call and Supabase
uvicorn app.main:app --reload --port 8000
```

Run `sql/schema.sql` once in the Supabase SQL editor before the first call.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `VAPI_WEBHOOK_SECRET` | yes | Shared secret checked on every webhook |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-side database key |
| `LEADS_API_KEY` | yes | Sent as `X-API-Key` to read leads |
| `VAPI_PRIVATE_KEY` | yes | Pulls finished calls from Vapi (`/calls/{id}/sync`, backfill, doctor) |
| `VAPI_ASSISTANT_ID` | yes for doctor | Ignore calls from other assistants |

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/webhooks/vapi` | Webhook secret | Receive Vapi events (optional path) |
| POST | `/calls/{call_id}/sync` | `X-API-Key` | Pull a call from Vapi and save it |
| GET | `/leads?lead_status=&limit=&offset=` | `X-API-Key` | List lead summaries, newest first |
| GET | `/leads/{call_id}` | `X-API-Key` | One lead with transcript |
| GET | `/health` | none | Uptime check |

## Stored lead fields

| Field | Type | Notes |
|---|---|---|
| `intent` | `self_use`, `investment`, `both` or null | |
| `geography_fit` | boolean or null | |
| `budget` | text or null | Customer's own words |
| `budget_fit` | boolean or null | |
| `timeline_fit` | boolean or null | |
| `objections` | text array | Empty when none |
| `follow_up_interest` | boolean or null | |
| `callback_preference` | text or null | |
| `lead_status` | see below | Computed by the server |
| `missing_fields`, `data_complete` | | Which fields the call did not capture |

`lead_status` is computed by a fixed rule in `app/extract.py`, not by the model, so the
same answers always give the same status:

| Status | Rule |
|---|---|
| `not_interested` | Customer declined the follow-up |
| `not_qualified` | Budget does not fit |
| `qualified` | Budget, geography and timeline fit, and follow-up accepted |
| `incomplete` | None of the three fit checks was captured |
| `nurture` | Anything else |

## Duplicates and missing data

- `vapi_call_id` is the primary key of both tables and every write is an upsert on it,
  so a retried webhook updates the same row.
- Before writing, the server merges with the stored row: an empty value never overwrites a
  stored one. A late or partial retry cannot erase a good lead.
- A database failure returns 503 so the delivery shows as failed and can be retried.
- Every lead field is nullable. An early hang-up is stored as an `incomplete` lead with
  its `missing_fields` listed.
