# WOW Concierge

A real-time AI voice agent for **Whispers of the Wind**, Divyasree Developers' villa-plot project near Nandi Hills, North Bengaluru.

The agent, Ananya, makes a short outbound-style sales call in English or Hindi. It asks permission, qualifies the buyer on intent, location, budget and timeline, pitches to their intent, handles objections, books a Property Expert follow-up, and produces a structured lead summary.

> Built as an assessment project. Not an official Divyasree Developers website.

## What the web app shows

- A live voice call from the browser (microphone in, real AI voice out)
- A live transcript of both sides
- Four qualification checkpoints that update during the call
- A lead summary after the call, saved to a database

## Stack

| Layer | Tools |
|---|---|
| Voice | Vapi (speech-to-text, LLM, text-to-speech, turn-taking) |
| Frontend | Next.js, React, TypeScript, `@vapi-ai/web` |
| Backend | Python, FastAPI, Supabase (Postgres) |

## Project structure

```
frontend/    Next.js web app (deploys to Vercel)
backend/     FastAPI service: saves calls and leads, serves the leads API
assistant/   The assistant's system prompt and first message
```

## Run locally

See [SETUP.md](SETUP.md) for the full step-by-step guide. In short:

```bash
# backend
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && cp .env.example .env   # fill in values
uvicorn app.main:app --reload --port 8000

# frontend (second terminal)
cd frontend && npm install && cp .env.example .env.local  # fill in values
npm run dev
```

## How it works

1. The browser starts a Vapi call with the assistant's ID and the public key.
2. Vapi streams transcripts and the assistant's checkpoint updates back to the page.
3. When the call ends, the app asks the backend to fetch the finished call from Vapi and save the transcript and lead to Supabase.
4. The summary panel shows the saved lead.

Private keys stay on the server: the browser only ever holds the Vapi public key.

## Environment variables

| Where | Variable | Notes |
|---|---|---|
| frontend | `NEXT_PUBLIC_VAPI_PUBLIC_KEY` | Safe in the browser |
| frontend | `NEXT_PUBLIC_VAPI_ASSISTANT_ID` | Safe in the browser |
| frontend | `VAPI_PRIVATE_KEY` | Server only |
| frontend | `BACKEND_URL`, `LEADS_API_KEY` | Server only; links to the backend |
| backend | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database |
| backend | `VAPI_PRIVATE_KEY`, `VAPI_ASSISTANT_ID` | Fetch finished calls |
| backend | `LEADS_API_KEY`, `VAPI_WEBHOOK_SECRET` | Shared secrets you choose |

Templates are in `frontend/.env.example` and `backend/.env.example`.
