# WOW Concierge: full project

```
wow-concierge-project/
  frontend/   Next.js web app (voice call, transcript, tracker, summary)
  backend/    FastAPI service (saves calls and leads to Supabase, leads API)
```

You need Node.js 20+, Python 3.11+, your Vapi account with the WOW Concierge assistant,
and a Supabase project.

Start the backend first, then the frontend. When both run, every call you end is saved
to Supabase automatically and its summary appears under the call.

---

## 1. Backend

### Create the tables (once)
Supabase > SQL Editor > paste all of `backend/sql/schema.sql` > Run.

### Install and configure
```bash
cd backend
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env             # Windows: copy .env.example .env
```
Fill in `backend/.env`:
```
VAPI_WEBHOOK_SECRET=any-long-random-string-you-invent
SUPABASE_URL=https://xxxx.supabase.co                 # Supabase > Project Settings > API
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key       # the service_role key, not anon
LEADS_API_KEY=another-long-random-string-you-invent
VAPI_PRIVATE_KEY=your-vapi-private-key                # Vapi > API Keys > Private key
VAPI_ASSISTANT_ID=your-assistant-id                   # Vapi > Assistants > WOW Concierge
```

### Check, then run
```bash
pytest -q                          # expect: 19 passed
python -m scripts.doctor           # checks your real assistant, last call and Supabase
uvicorn app.main:app --reload --port 8000
```
Leave this terminal running.

---

## 2. Frontend

In a second terminal:
```bash
cd frontend
npm install
cp .env.example .env.local         # Windows: copy .env.example .env.local
```
Fill in `frontend/.env.local`:
```
NEXT_PUBLIC_VAPI_PUBLIC_KEY=your-vapi-public-key
NEXT_PUBLIC_VAPI_ASSISTANT_ID=your-assistant-id
VAPI_PRIVATE_KEY=your-vapi-private-key
BACKEND_URL=http://localhost:8000
LEADS_API_KEY=the-same-value-as-in-backend/.env
```
Then:
```bash
npm run dev
```
Open http://localhost:3000 and click **Start conversation**.

---

## 3. Live tracker during the call (one-time Vapi setup)

The summary and lead fields need no Vapi setup. The tracker updating *during* the call
needs the assistant to report what it learns:

1. Vapi > Tools > Create Tool > Function. Paste `frontend/vapi/update_qualification.tool.json`.
   Leave its Server URL empty.
2. Attach the tool to the WOW Concierge assistant.
3. Paste the "Recording qualification" paragraph from `frontend/README.md` into the
   assistant's system prompt and publish.

Without this, the four checkpoints fill in from the summary after the call instead.

---

## 4. Check it worked

1. Talk for at least a minute, then click **End conversation**.
2. Within a minute the summary appears and says **Saved to your leads database**.
3. The row is in Supabase > Table Editor > `leads` (and the transcript in `calls`).
4. Or: `curl -H "X-API-Key: <LEADS_API_KEY>" http://localhost:8000/leads`

If anything is missing, run `python -m scripts.doctor` in `backend/`. It says exactly what to fix.

---

## Optional: saving phone calls

Web calls are saved by the step above. Phone calls never pass through the web app, so they
need Vapi to push to the backend: run `ngrok http 8000`, set the assistant's Server URL to
`https://<ngrok-address>/webhooks/vapi`, attach a Bearer Token credential equal to
`VAPI_WEBHOOK_SECRET`, and tick `end-of-call-report`.

---

## Troubleshooting

| What you see | Cause |
|---|---|
| "Add your Vapi details to start" | `.env.local` missing, or dev server not restarted after editing it |
| "Not saved. The backend at ... did not respond" | Backend isn't running on port 8000 |
| "Not saved. The backend rejected LEADS_API_KEY" | The key differs between the two `.env` files |
| "Not saved. ... Could not save to Supabase" | `schema.sql` not run, or the anon key used instead of service_role |
| Summary still loading after a minute | Very short call; talk for at least a minute |
| Tracker only fills after the call | The tool or prompt paragraph from step 3 is missing |
