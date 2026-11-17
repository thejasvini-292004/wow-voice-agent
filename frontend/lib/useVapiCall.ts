"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type Vapi from "@vapi-ai/web";
import { LEAD_OUTPUT, type Lead } from "./lead";
import {
  emptyQualification,
  parseQualificationArgs,
  type Qualification,
} from "./qualification";

export type CallStatus =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "active"
  | "ending"
  | "ended"
  | "error";

export interface TranscriptLine {
  id: string;
  role: "assistant" | "user";
  text: string;
  at: number;
}

export interface CallError {
  title: string;
  detail: string;
}

export interface LeadSummary {
  status: string | null;
  endedReason: string | null;
  durationSeconds: number | null;
  summary: string | null;
  lead: Lead | null;
  /** True when the call was saved to Supabase through the backend. */
  stored: boolean;
  /** Why the call was not saved, when it wasn't. */
  storageNote: string | null;
  ready: boolean;
}

export type SummaryState =
  | { phase: "none" }
  | { phase: "loading" }
  | { phase: "ready"; data: LeadSummary }
  | { phase: "partial"; data: LeadSummary | null; reason: string };

const PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? "";
const ASSISTANT_ID = process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID ?? "";
const TOOL_NAME = "update_qualification";
const CONNECT_TIMEOUT_MS = 20_000;
const MAX_CALL_SECONDS = 300;
/** Pause after the closing words are heard, so they finish cleanly before the line closes. */
const HANGUP_AFTER_CLOSING_MS = 700;

/**
 * Closing lines that end the call. Vapi matches these case-insensitively as substrings of
 * what the assistant says, waits for it to finish speaking, then hangs up. Kept specific so
 * they can't match mid-conversation. "end call triggered" catches a model that announces
 * hanging up instead of doing it.
 */
const END_CALL_PHRASES = [
  "goodbye",
  "good bye",
  "have a great day",
  "have a lovely day",
  "end call",
  "end_call",
  "अलविदा",
  "दिन अच्छा रहे",
  "दिन शुभ रहे",
  "دن اچھا رہے",
  "ख़ुदा हाफ़िज़",
  "खुदा हाफिज",
  "خدا حافظ",
];
/** Arabic/Urdu script. Vapi's speech-to-text writes spoken Hindi this way. */
const ARABIC_SCRIPT = /[\u0600-\u06FF]/;

const END_CALL_PATTERN = new RegExp(END_CALL_PHRASES.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "i");

/**
 * When Vapi closes a call from its side (for example after the goodbye), the calling library
 * underneath it logs "Meeting ended due to ejection: Meeting has ended" as a console error.
 * It is a normal end of call, and this hook already treats it as one, but Next.js shows every
 * console error as a red "Issue" in development. This drops only that message; every other
 * error still reaches the console.
 */
const NORMAL_END_MESSAGE = /meeting ended due to ejection|meeting has ended/i;

function muteNormalEndLog() {
  const w = window as unknown as { __wowConsolePatched?: boolean };
  if (w.__wowConsolePatched) return;
  w.__wowConsolePatched = true;
  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const text = args
      .map((a) => {
        if (typeof a === "string") return a;
        const e = a as { message?: unknown; errorMsg?: unknown } | null;
        if (e && typeof e.message === "string") return e.message;
        if (e && typeof e.errorMsg === "string") return e.errorMsg;
        try {
          return JSON.stringify(a);
        } catch {
          return "";
        }
      })
      .join(" ");
    if (NORMAL_END_MESSAGE.test(text)) {
      console.info("[WOW Concierge] Vapi closed the call (normal end).");
      return;
    }
    original(...args);
  };
}

/** Turns a getUserMedia failure into something the visitor can act on. */
function describeMicError(err: unknown): CallError {
  const name = (err as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      title: "Microphone access is blocked",
      detail:
        "Allow the microphone for this site from the lock icon in your address bar, then start the conversation again.",
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      title: "No microphone found",
      detail: "Connect a microphone or headset, then start the conversation again.",
    };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      title: "The microphone is in use",
      detail: "Close other apps that are using your microphone, then start the conversation again.",
    };
  }
  return {
    title: "The microphone could not be opened",
    detail: "Check your browser's microphone settings, then start the conversation again.",
  };
}

/** Vapi and its WebRTC layer report errors in several shapes; pull out readable text. */
function errorText(err: unknown): string {
  if (!err) return "";
  if (typeof err === "string") return err;
  const e = err as Record<string, any>;
  const candidates = [
    e.error?.message?.msg,
    e.error?.message,
    e.error?.errorMsg,
    e.error?.msg,
    e.errorMsg,
    e.message,
    typeof e.error === "string" ? e.error : undefined,
  ];
  const found = candidates.find((c) => typeof c === "string" && c.length > 0);
  if (found) return found;
  try {
    return JSON.stringify(err).slice(0, 300);
  } catch {
    return "Unknown error";
  }
}

export function useVapiCall() {
  const vapiRef = useRef<Vapi | null>(null);
  const statusRef = useRef<CallStatus>("idle");
  const callIdRef = useRef<string | null>(null);
  const seenToolCalls = useRef<Set<string>>(new Set());
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const summaryRun = useRef(0);
  const closingSaid = useRef(false);
  const assistantSpeaking = useRef(false);
  const hangupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [status, setStatusState] = useState<CallStatus>("idle");
  const [speaker, setSpeaker] = useState<"assistant" | "user" | null>(null);
  const [volume, setVolume] = useState(0);
  const [muted, setMuted] = useState(false);
  const [online, setOnline] = useState(true);
  const [weakNetwork, setWeakNetwork] = useState(false);
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [partial, setPartial] = useState<{ role: "assistant" | "user"; text: string } | null>(null);
  const [qualification, setQualification] = useState<Qualification>(emptyQualification);
  const [error, setError] = useState<CallError | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const [endedReason, setEndedReason] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryState>({ phase: "none" });

  const configured = Boolean(PUBLIC_KEY && ASSISTANT_ID);

  const setStatus = useCallback((s: CallStatus) => {
    statusRef.current = s;
    setStatusState(s);
  }, []);

  const clearTimers = () => {
    if (connectTimer.current) clearTimeout(connectTimer.current);
    if (endTimer.current) clearTimeout(endTimer.current);
    if (hangupTimer.current) clearTimeout(hangupTimer.current);
    connectTimer.current = null;
    endTimer.current = null;
    hangupTimer.current = null;
    closingSaid.current = false;
    assistantSpeaking.current = false;
  };


  /** Applies one update_qualification tool call. Deduped by tool call id. */
  const applyToolCall = useCallback((id: string | undefined, name: string | undefined, args: unknown) => {
    if (name !== TOOL_NAME) return;
    const key = id ?? JSON.stringify(args);
    if (seenToolCalls.current.has(key)) return;
    const parsed = parseQualificationArgs(args);
    if (!parsed) return;
    seenToolCalls.current.add(key);
    setQualification((q) => ({ ...q, [parsed.key]: parsed.checkpoint }));
  }, []);

  /** Polls the server route until Vapi has finished its post-call analysis. */
  const loadSummary = useCallback(async (callId: string) => {
    const run = ++summaryRun.current;
    setSummary({ phase: "loading" });
    let last: LeadSummary | null = null;
    // Vapi writes the summary a few seconds to about a minute after the call ends.
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 2000 : 3000));
      if (run !== summaryRun.current) return;
      try {
        const res = await fetch(`/api/calls/${callId}`, { cache: "no-store" });
        if (res.status === 501) {
          setSummary({
            phase: "partial",
            data: null,
            reason:
              "The app can't read the finished call: set VAPI_PRIVATE_KEY, or BACKEND_URL and LEADS_API_KEY, in .env.local and restart.",
          });
          return;
        }
        if (res.ok) {
          last = (await res.json()) as LeadSummary;
          if (last.ready) {
            if (run === summaryRun.current) setSummary({ phase: "ready", data: last });
            return;
          }
        }
      } catch {
        // Network blip: keep trying until the attempts run out.
      }
    }
    if (run !== summaryRun.current) return;
    setSummary({
      phase: "partial",
      data: last,
      reason: last
        ? "Vapi has not produced a summary for this call yet. Very short calls are sometimes skipped; try a call of at least a minute."
        : "The finished call could not be read from Vapi. Check VAPI_PRIVATE_KEY and the assistant ID in .env.local.",
    });
  }, []);

  const finishCall = useCallback(() => {
    if (statusRef.current === "ended" || statusRef.current === "idle") return;
    const hadCall = statusRef.current === "active" || statusRef.current === "ending";
    clearTimers();
    setSpeaker(null);
    setVolume(0);
    setPartial(null);
    setWeakNetwork(false);
    if (statusRef.current === "error") return;
    if (!hadCall) {
      // The line closed before the call ever connected.
      setError({
        title: "The call ended before it connected",
        detail: "Check the assistant ID and your connection, then start the conversation again.",
      });
      setStatus("error");
      return;
    }
    setEndedAt(Date.now());
    setStatus("ended");
    if (callIdRef.current) void loadSummary(callIdRef.current);
    else
      setSummary({
        phase: "partial",
        data: null,
        reason: "Vapi did not return a call ID, so the written summary could not be fetched.",
      });
  }, [loadSummary, setStatus]);

  const fail = useCallback(
    (e: CallError) => {
      const wasLive = statusRef.current === "active" || statusRef.current === "ending";
      clearTimers();
      setError(e);
      setSpeaker(null);
      setVolume(0);
      setPartial(null);
      if (wasLive) {
        // A call that dropped mid-way still has a transcript and a record worth showing.
        setEndedAt(Date.now());
        setStatus("ended");
        if (callIdRef.current) void loadSummary(callIdRef.current);
      } else {
        setStatus("error");
      }
      try {
        void vapiRef.current?.stop();
      } catch {
        /* already stopped */
      }
    },
    [loadSummary, setStatus]
  );

  // Create the SDK client once, in the browser, and subscribe to its real events.
  useEffect(() => {
    if (!configured) return;
    let disposed = false;
    let vapi: Vapi | null = null;
    muteNormalEndLog();

    void import("@vapi-ai/web").then(({ default: VapiClient }) => {
      if (disposed) return;
      vapi = new VapiClient(PUBLIC_KEY);
      vapiRef.current = vapi;

      vapi.on("call-start", () => {
        if (connectTimer.current) clearTimeout(connectTimer.current);
        setStartedAt(Date.now());
        setStatus("active");
      });

      vapi.on("call-end", () => finishCall());

      vapi.on("speech-start", () => {
        assistantSpeaking.current = true;
        setSpeaker("assistant");
      });
      // Hang up as soon as the closing line has been spoken. Vapi's assistant transcripts follow
      // the audio word by word, so the moment the goodbye appears it has just been said. Closing
      // the line shortly after cuts off anything the model might add, such as reading out a tool name.
      const hangUpSoon = () => {
        if (hangupTimer.current || statusRef.current !== "active") return;
        hangupTimer.current = setTimeout(() => {
          hangupTimer.current = null;
          if (statusRef.current === "active") {
            setStatus("ending");
            void vapi?.stop();
            endTimer.current = setTimeout(() => finishCall(), 5000);
          }
        }, HANGUP_AFTER_CLOSING_MS);
      };

      vapi.on("speech-end", () => {
        assistantSpeaking.current = false;
        setSpeaker((s) => (s === "assistant" ? null : s));
        if (closingSaid.current) hangUpSoon();
      });
      vapi.on("volume-level", (v: number) => setVolume(v));

      vapi.on("message", (m: any) => {
        if (!m || typeof m !== "object") return;
        const type = String(m.type ?? "");

        if (type.startsWith("transcript")) {
          const role = m.role === "assistant" ? "assistant" : "user";
          const text = String(m.transcript ?? "").trim();
          if (!text) return;
          // Checked on partial and final text alike, so the hang-up starts while the goodbye is heard.
          if (role === "assistant" && END_CALL_PATTERN.test(text)) {
            closingSaid.current = true;
            hangUpSoon();
          }
          if (m.transcriptType === "final" || type.includes("final")) {
            setPartial((p) => (p?.role === role ? null : p));
            // The assistant's own words arrive in Devanagari through conversation-update.
            // Skip Vapi's re-transcription of its speech, which renders Hindi in Urdu script.
            if (role === "assistant" && ARABIC_SCRIPT.test(text)) return;
            setLines((prev) => [
              ...prev,
              { id: `${Date.now()}-${prev.length}`, role, text, at: Date.now() },
            ]);
          } else {
            if (role === "assistant" && ARABIC_SCRIPT.test(text)) return;
            setPartial({ role, text });
          }
          return;
        }

        if (type === "speech-update" && m.role === "user") {
          setSpeaker((s) => (m.status === "started" ? "user" : s === "user" ? null : s));
          return;
        }

        if (type === "tool-calls") {
          const list: any[] = m.toolCallList ?? m.toolCalls ?? [];
          for (const tc of list) applyToolCall(tc?.id, tc?.function?.name, tc?.function?.arguments);
          for (const t of (m.toolWithToolCallList ?? []) as any[]) {
            const tc = t?.toolCall;
            applyToolCall(tc?.id, tc?.function?.name, tc?.function?.arguments ?? tc?.parameters);
          }
          return;
        }

        // The running conversation log. With modelOutputInMessagesEnabled it holds exactly what
        // the model wrote, so it is the authoritative transcript: rebuild the display from it.
        // It is also a second source for the qualification tool calls.
        if (type === "conversation-update") {
          const msgs: any[] = m.messagesOpenAIFormatted ?? m.conversation ?? [];
          const rebuilt: TranscriptLine[] = [];
          for (const msg of msgs) {
            for (const tc of (msg?.tool_calls ?? []) as any[]) {
              applyToolCall(tc?.id, tc?.function?.name, tc?.function?.arguments);
            }
            const role = msg?.role === "assistant" ? "assistant" : msg?.role === "user" ? "user" : null;
            const content = typeof msg?.content === "string" ? msg.content.trim() : "";
            if (role && content) {
              rebuilt.push({ id: `h-${rebuilt.length}`, role, text: content, at: Date.now() });
            }
          }
          if (rebuilt.length) {
            setLines(rebuilt);
            const last = rebuilt[rebuilt.length - 1];
            setPartial((p) => (p?.role === last.role ? null : p));
          }
          return;
        }

        if (type === "status-update") {
          if (m.endedReason) setEndedReason(String(m.endedReason));
          if (m.status === "ended") finishCall();
          return;
        }

        if (type === "hang") setWeakNetwork(true);
      });

      vapi.on("call-start-failed", (e: any) => {
        fail({
          title: "The call could not be connected",
          detail:
            errorText(e) ||
            "Vapi rejected the call. Check the public key and assistant ID, then try again.",
        });
      });

      vapi.on("network-quality-change", (e: any) => {
        const q = e?.threshold ?? e?.quality;
        setWeakNetwork(q === "low" || q === "very-low");
      });

      vapi.on("network-connection", (e: any) => {
        if (e?.event === "interrupted") setWeakNetwork(true);
        if (e?.event === "connected") setWeakNetwork(false);
      });

      vapi.on("error", (e: any) => {
        const text = errorText(e);
        // The WebRTC room closing after a normal hang-up is reported as an error. Treat it as the end of the call.
        if (/meeting has ended|ejected|left the meeting/i.test(text)) {
          finishCall();
          return;
        }
        if (statusRef.current === "idle" || statusRef.current === "ended") return;
        if (/permission|notallowed|microphone|getusermedia/i.test(text)) {
          fail(describeMicError({ name: "NotAllowedError" }));
          return;
        }
        fail({
          title:
            statusRef.current === "active" ? "The call was interrupted" : "The call could not be connected",
          detail: !navigator.onLine
            ? "Your internet connection dropped. Reconnect, then start a new conversation."
            : text || "Something went wrong on the line. Start a new conversation to try again.",
        });
      });
    });

    return () => {
      disposed = true;
      clearTimers();
      summaryRun.current++;
      try {
        vapi?.removeAllListeners();
        void vapi?.stop();
      } catch {
        /* nothing to stop */
      }
      vapiRef.current = null;
    };
  }, [applyToolCall, configured, fail, finishCall, setStatus]);

  // Browser connectivity.
  useEffect(() => {
    setOnline(navigator.onLine);
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  const start = useCallback(async () => {
    const vapi = vapiRef.current;
    if (!configured || !vapi) return;
    if (["requesting-mic", "connecting", "active", "ending"].includes(statusRef.current)) return;

    // Fresh call: clear everything from the previous one.
    summaryRun.current++;
    seenToolCalls.current.clear();
    callIdRef.current = null;
    setError(null);
    setLines([]);
    setPartial(null);
    setQualification(emptyQualification());
    setSummary({ phase: "none" });
    setStartedAt(null);
    setEndedAt(null);
    setEndedReason(null);
    setMuted(false);
    setWeakNetwork(false);

    if (!navigator.onLine) {
      setError({
        title: "You're offline",
        detail: "Reconnect to the internet, then start the conversation.",
      });
      setStatus("error");
      return;
    }

    // Ask for the microphone ourselves first, so a refusal gets a clear message
    // instead of a failed call. The test stream is released straight away.
    setStatus("requesting-mic");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw { name: "NotFoundError" };
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      setError(describeMicError(err));
      setStatus("error");
      return;
    }

    setStatus("connecting");
    connectTimer.current = setTimeout(() => {
      if (statusRef.current === "connecting") {
        fail({
          title: "The call is taking too long to connect",
          detail: "Check your internet connection, then start the conversation again.",
        });
      }
    }, CONNECT_TIMEOUT_MS);

    try {
      // Prompt, voice, model and tools all come from the saved assistant. The call adds two things:
      // - clientMessages: which live events Vapi forwards to this browser.
      // - artifactPlan.structuredOutputs: the post-call summary and lead extraction. Sending it with
      //   the call means it works without any setup in the Vapi dashboard.
      const overrides = {
        clientMessages: [
          "transcript",
          "tool-calls",
          "conversation-update",
          "status-update",
          "speech-update",
          "hang",
        ],
        artifactPlan: { structuredOutputs: [LEAD_OUTPUT] },
        // Keep the model's own text (Devanagari for Hindi) in the conversation history and transcript,
        // instead of Vapi's speech-to-text of the assistant's voice, which writes Hindi in Urdu script.
        modelOutputInMessagesEnabled: true,
        // Ends the call when the assistant says a closing line, and caps cost if it never does.
        endCallPhrases: END_CALL_PHRASES,
        maxDurationSeconds: MAX_CALL_SECONDS,
      } as any;
      const call = await vapi.start(ASSISTANT_ID, overrides);
      if (call?.id) callIdRef.current = call.id;
      else if (statusRef.current === "connecting") {
        fail({
          title: "The call could not be connected",
          detail: "Vapi did not start the call. Check the public key and assistant ID, then try again.",
        });
      }
    } catch (err) {
      fail({
        title: "The call could not be connected",
        detail: errorText(err) || "Check your internet connection, then try again.",
      });
    }
  }, [configured, fail, setStatus]);

  const stop = useCallback(() => {
    const vapi = vapiRef.current;
    if (!vapi) return;
    if (statusRef.current === "connecting" || statusRef.current === "requesting-mic") {
      clearTimers();
      void vapi.stop();
      setStatus("idle");
      return;
    }
    if (statusRef.current !== "active") return;
    setStatus("ending");
    void vapi.stop();
    // If the SDK never confirms, close the call on our side.
    endTimer.current = setTimeout(() => finishCall(), 5000);
  }, [finishCall, setStatus]);

  const toggleMute = useCallback(() => {
    const vapi = vapiRef.current;
    if (!vapi || statusRef.current !== "active") return;
    const next = !vapi.isMuted();
    vapi.setMuted(next);
    setMuted(next);
  }, []);

  return {
    configured,
    status,
    speaker,
    volume,
    muted,
    online,
    weakNetwork,
    lines,
    partial,
    qualification,
    error,
    startedAt,
    endedAt,
    endedReason,
    summary,
    start,
    stop,
    toggleMute,
  };
}
