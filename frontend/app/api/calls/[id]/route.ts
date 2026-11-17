import { NextResponse } from "next/server";
import { extractFromCall, hasLeadData, normaliseLead, type Lead } from "@/lib/lead";

// Runs on the server only. Private keys are read here and never sent to the browser.
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Payload {
  status: string | null;
  endedReason: string | null;
  durationSeconds: number | null;
  summary: string | null;
  lead: Lead | null;
  stored: boolean;
  storageNote: string | null;
  ready: boolean;
}

function finalise(p: Omit<Payload, "ready">): Payload {
  const ended = p.status === "ended";
  return { ...p, ready: ended && Boolean(p.summary || hasLeadData(p.lead)) };
}

/**
 * Preferred path: ask the FastAPI backend to pull this call from Vapi and save it.
 * This stores every call without needing Vapi webhooks, ngrok or a public URL.
 */
async function viaBackend(id: string): Promise<Payload | string> {
  const base = process.env.BACKEND_URL?.replace(/\/+$/, "");
  const key = process.env.LEADS_API_KEY;
  // No backend configured is a deliberate setup choice, not an error, so say nothing about saving.
  if (!base || !key) return "";
  let res: Response;
  try {
    res = await fetch(`${base}/calls/${id}/sync`, {
      method: "POST",
      headers: { "X-API-Key": key },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return `The backend at ${base} did not respond, so the call was not saved. Is it running?`;
  }
  if (res.status === 401) return "The backend rejected LEADS_API_KEY, so the call was not saved.";
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    return `The backend could not save the call (${res.status}${detail?.detail ? `: ${detail.detail}` : ""}).`;
  }
  const b = await res.json();
  return finalise({
    status: b.call_status ?? null,
    endedReason: b.ended_reason ?? null,
    durationSeconds: b.duration_seconds ?? null,
    summary: b.summary ?? null,
    lead: b.lead ? normaliseLead(b.lead) : null,
    stored: true,
    storageNote: null,
  });
}

/** Fallback path: read the call straight from Vapi. Shows the summary but saves nothing. */
async function viaVapi(id: string, storageNote: string): Promise<Payload | NextResponse> {
  const privateKey = process.env.VAPI_PRIVATE_KEY;
  if (!privateKey) return NextResponse.json({ error: "summary_not_configured" }, { status: 501 });
  let res: Response;
  try {
    res = await fetch(`https://api.vapi.ai/call/${id}`, {
      headers: { Authorization: `Bearer ${privateKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return NextResponse.json({ error: "vapi_unreachable" }, { status: 502 });
  }
  if (res.status === 404) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (res.status === 401) return NextResponse.json({ error: "vapi_key_rejected" }, { status: 502 });
  if (!res.ok) return NextResponse.json({ error: "vapi_error" }, { status: 502 });

  const call = (await res.json()) as Record<string, any>;
  const assistantId = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
  if (assistantId && call.assistantId && call.assistantId !== assistantId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const started = call.startedAt ? Date.parse(call.startedAt) : NaN;
  const ended = call.endedAt ? Date.parse(call.endedAt) : NaN;
  const { summary, lead } = extractFromCall(call);
  return finalise({
    status: call.status ?? null,
    endedReason: call.endedReason ?? null,
    durationSeconds:
      Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, Math.round((ended - started) / 1000)) : null,
    summary,
    lead,
    stored: false,
    storageNote: storageNote || null,
  });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "invalid_call_id" }, { status: 400 });

  const backend = await viaBackend(id);
  const result = typeof backend === "string" ? await viaVapi(id, backend) : backend;
  if (result instanceof NextResponse) return result;
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
