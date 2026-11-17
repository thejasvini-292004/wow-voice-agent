# WOW Concierge

A web interface for the WOW Concierge voice assistant (Whispers of the Wind, Divyasree Developers).
It places a real voice call to your Vapi assistant from the browser. Nothing on screen is simulated:
status, transcript, checkpoints and summary all come from Vapi.

## Run it

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env.local   # then fill in the three values
npm run dev                  # http://localhost:3000
```

Microphone access only works on `localhost` or over HTTPS.

## Credentials

| Variable | Where it lives | Where to find it |
|---|---|---|
| `NEXT_PUBLIC_VAPI_PUBLIC_KEY` | Browser | Vapi dashboard, API Keys, Public key |
| `NEXT_PUBLIC_VAPI_ASSISTANT_ID` | Browser | Vapi dashboard, Assistants, WOW Concierge, copy ID |
| `VAPI_PRIVATE_KEY` | Server only | Vapi dashboard, API Keys, Private key |
| `BACKEND_URL` | Server only | Where the FastAPI backend runs, e.g. `http://localhost:8000` |
| `LEADS_API_KEY` | Server only | Same value as in `backend/.env` |

The public key can only start calls, which is why it is safe in frontend code. Restrict it to your
deployed domain in the Vapi dashboard. The private key is read only inside
`app/api/calls/[id]/route.ts` and is never sent to the browser. `.env.local` is git-ignored.

## How the three integrations work

### 1. Voice call: `lib/useVapiCall.ts`

`new Vapi(publicKey)` then `vapi.start(assistantId)` opens a WebRTC call. The hook listens to these SDK events:

| Event | Used for |
|---|---|
| `call-start`, `call-end`, `call-start-failed` | Call status and timer |
| `speech-start`, `speech-end`, `volume-level` | "Concierge is speaking" and the moving hill lines |
| `message` with `type: "transcript"` | Live transcript (partial lines shown faded, final lines kept) |
| `message` with `type: "tool-calls"` or `"conversation-update"` | Qualification tracker |
| `message` with `type: "status-update"` | Reason the call ended |
| `error`, `network-quality-change`, `network-connection` | Error and weak-connection messages |

Before starting, the app requests the microphone itself so a refusal produces a clear message.

### 2. Qualification tracker: one tool on the assistant

The tracker updates only when the assistant calls a tool named `update_qualification`.
You need to add it once:

1. Vapi dashboard, Tools, Create Tool, Function.
2. Paste the definition from `vapi/update_qualification.tool.json`. Leave the **Server URL empty**;
   that is what makes Vapi deliver the call to the browser. Keep `async` on so the assistant does
   not pause while it records.
3. Attach the tool to the WOW Concierge assistant.
4. Add this to the assistant's system prompt:

```
## Recording qualification
You have a tool called update_qualification. Call it silently every time you learn
something about one of the four checkpoints: intent, geography, budget, timeline.
- Call it as soon as the customer reveals the information, even if you had not asked yet.
- If one sentence covers two checkpoints, call the tool once for each.
- If the customer changes their answer, call it again with the new finding.
- Never mention the tool or say that you are noting something down.
- Never ask about a checkpoint you have already recorded.
```

Without this tool the call and transcript still work; the four checkpoints stay at "Not yet discussed".

### 3. Lead summary and saving: `app/api/calls/[id]/route.ts`

Every call is started with a structured output (`LEAD_OUTPUT` in `lib/lead.ts`) attached
through `artifactPlan`. After the call, Vapi runs it over the transcript and writes a summary
plus the lead fields onto the call record. No dashboard setup is needed for this.

When the call ends, the browser polls `/api/calls/<callId>` for up to about 90 seconds:

1. If `BACKEND_URL` and `LEADS_API_KEY` are set, the route asks the FastAPI backend to pull the
   call from Vapi and save it to Supabase (`POST /calls/{id}/sync`). The summary panel then says
   "Saved to your leads database".
2. Otherwise, or if the backend is down, it reads the call straight from Vapi with
   `VAPI_PRIVATE_KEY`. The summary still shows, but the panel says it was not saved and why.

After the call, any checkpoint the live tracker missed is filled from the summary and marked
"From the call summary".

## Error handling

| Situation | What the visitor sees |
|---|---|
| Microphone blocked, missing or busy | A specific message with the fix |
| Offline before starting | Start button disabled and an offline notice |
| Call fails to connect within 20 seconds | The call is cancelled with a retry message |
| Connection weakens mid-call | A non-blocking notice |
| Call drops mid-way | The transcript is kept and the summary is still fetched |
| Assistant or customer hangs up | Normal end, summary shown |

## Deploy

Deploy to Vercel (or any Node host), set the three environment variables there, and add the deployed
domain to the public key's allowed origins in Vapi.
