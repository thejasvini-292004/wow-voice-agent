"use client";

import { useEffect, useRef, useState } from "react";
import { useVapiCall, type CallStatus } from "@/lib/useVapiCall";
import { fillFromLead, type Lead } from "@/lib/lead";
import {
  CHECKPOINTS,
  CHECKPOINT_COPY,
  STATUS_COPY,
  type Qualification,
} from "@/lib/qualification";

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: "Ready when you are",
  "requesting-mic": "Waiting for microphone access",
  connecting: "Connecting your call",
  active: "On the call",
  ending: "Ending the call",
  ended: "Call ended",
  error: "Call not connected",
};

const ENDED_REASON: Record<string, string> = {
  "customer-ended-call": "You ended the call",
  "assistant-ended-call": "The concierge ended the call",
  "assistant-said-end-call-phrase": "The concierge closed the conversation",
  "silence-timed-out": "The call ended after a long silence",
  "exceeded-max-duration": "The call reached its time limit",
};

function formatDuration(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function humanize(key: string) {
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

const LEAD_STATUS_COPY: Record<string, string> = {
  qualified: "Qualified",
  nurture: "Nurture",
  not_qualified: "Not qualified",
  not_interested: "Not interested",
  incomplete: "Incomplete",
};

const yesNo = (v: boolean | null, yes: string, no: string) => (v === null ? "Not captured" : v ? yes : no);

function leadRows(lead: Lead | null): { label: string; value: string }[] {
  if (!lead) return [];
  return [
    { label: "Lead status", value: LEAD_STATUS_COPY[lead.lead_status ?? ""] ?? humanize(lead.lead_status ?? "unknown") },
    { label: "Stated budget", value: lead.budget ?? "Not captured" },
    { label: "Follow-up call", value: yesNo(lead.follow_up_interest, "Agreed", "Declined") },
    { label: "Best time to call", value: lead.callback_preference ?? "Not captured" },
    { label: "Objections", value: lead.objections.length ? lead.objections.join("; ") : "None raised" },
  ];
}

function HillStage({ level, live }: { level: number; live: boolean }) {
  // Contour lines of a hill range. The call's real output volume lifts and brightens them.
  const lift = live ? Math.min(1, level * 1.6) : 0;
  const ridges = [
    "M0 150 C 90 120, 150 70, 230 78 S 360 150, 440 120 S 560 60, 640 96 L 640 220 L 0 220 Z",
    "M0 166 C 100 140, 160 96, 236 102 S 360 164, 444 138 S 560 90, 640 120 L 640 220 L 0 220 Z",
    "M0 180 C 110 160, 170 124, 242 128 S 364 178, 448 156 S 564 120, 640 144 L 640 220 L 0 220 Z",
    "M0 194 C 120 178, 180 150, 248 154 S 368 192, 452 174 S 568 150, 640 168 L 640 220 L 0 220 Z",
    "M0 206 C 130 196, 190 176, 254 180 S 372 206, 456 192 S 572 178, 640 190 L 640 220 L 0 220 Z",
  ];
  return (
    <svg className="hills" viewBox="0 0 640 220" preserveAspectRatio="none" aria-hidden="true">
      {ridges.map((d, i) => (
        <path
          key={i}
          d={d}
          className="ridge"
          style={{
            transform: `translateY(${-lift * (ridges.length - i) * 3.2}px)`,
            opacity: 0.22 + i * 0.12 + lift * 0.25,
          }}
        />
      ))}
    </svg>
  );
}

function Tracker({ qualification }: { qualification: Qualification }) {
  return (
    <ol className="tracker" aria-label="Qualification checkpoints">
      {CHECKPOINTS.map((key) => {
        const c = qualification[key];
        const copy = CHECKPOINT_COPY[key];
        return (
          <li key={key} className={`checkpoint is-${c.status}`}>
            <div className="checkpoint-head">
              <span className="marker" aria-hidden="true" />
              <h3>{copy.title}</h3>
            </div>
            <p className="checkpoint-question">{copy.question}</p>
            <p className="checkpoint-state">{STATUS_COPY[c.status]}</p>
            {c.value && <p className="checkpoint-value">{c.value}</p>}
            {c.quote && <p className="checkpoint-quote">“{c.quote}”</p>}
            {c.fromSummary && <p className="checkpoint-quote">From the call summary</p>}
          </li>
        );
      })}
    </ol>
  );
}

export default function Concierge() {
  const call = useVapiCall();
  const { status, lines, partial, qualification, summary } = call;
  const live = status === "active" || status === "ending";
  const busy = status === "requesting-mic" || status === "connecting";
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, partial]);

  const elapsed =
    call.startedAt !== null
      ? Math.max(0, Math.round(((call.endedAt ?? now) - call.startedAt) / 1000))
      : 0;
  const summaryData = summary.phase === "ready" || summary.phase === "partial" ? summary.data : null;
  // Live checkpoints from the assistant's tool calls, topped up from the post-call summary.
  const shown = fillFromLead(qualification, summaryData?.lead ?? null);
  const captured = CHECKPOINTS.filter((k) => shown[k].status !== "pending").length;
  const fits = CHECKPOINTS.filter((k) => shown[k].status === "confirmed").length;
  const rows = leadRows(summaryData?.lead ?? null);
  const duration = summaryData?.durationSeconds ?? elapsed;
  const reasonKey = summaryData?.endedReason ?? call.endedReason ?? "";

  let statusLine = STATUS_LABEL[status];
  if (status === "active") {
    if (call.muted) statusLine = "On the call, your microphone is muted";
    else if (call.speaker === "assistant") statusLine = "The concierge is speaking";
    else if (call.speaker === "user") statusLine = "Listening to you";
    else statusLine = "On the call";
  }

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <p className="project">Whispers of the Wind</p>
          <p className="byline">Private valley villa plots, Nandi Hills, North Bengaluru</p>
        </div>
        <p className="product">WOW Concierge</p>
      </header>

      {!call.configured && (
        <div className="notice" role="alert">
          <strong>Add your Vapi details to start.</strong> Set{" "}
          <code>NEXT_PUBLIC_VAPI_PUBLIC_KEY</code> and <code>NEXT_PUBLIC_VAPI_ASSISTANT_ID</code>: in{" "}
          <code>.env.local</code> when running locally, or in your host&apos;s environment variables when
          deployed. Then rebuild the app.
        </div>
      )}
      {!call.online && (
        <div className="notice" role="status">
          <strong>You're offline.</strong> The call needs an internet connection.
        </div>
      )}
      {live && call.online && call.weakNetwork && (
        <div className="notice is-soft" role="status">
          Your connection is weak, so the concierge may sound delayed.
        </div>
      )}

      <section className="call-row">
        <div className={`stage ${live ? "is-live" : ""}`}>
          <HillStage level={call.volume} live={status === "active"} />
          <div className="stage-body">
            <h1>Your private escape to the valley begins here.</h1>
            <p className="lede">
              A two to three minute voice call. You'll need a microphone; headphones give the
              clearest sound.
            </p>

            <div className="status" role="status" aria-live="polite">
              <span className={`pulse is-${status}`} aria-hidden="true" />
              <span>{statusLine}</span>
              {(live || status === "ended") && call.startedAt !== null && (
                <span className="timer">{formatDuration(elapsed)}</span>
              )}
            </div>

            <div className="controls">
              {!live && (
                <button
                  className="btn btn-primary"
                  onClick={busy ? call.stop : call.start}
                  disabled={!call.configured || (!busy && !call.online)}
                >
                  {busy
                    ? "Cancel"
                    : status === "ended" || status === "error"
                      ? "Start a new conversation"
                      : "Start conversation"}
                </button>
              )}
              {live && (
                <>
                  <button
                    className="btn btn-end"
                    onClick={call.stop}
                    disabled={status === "ending"}
                  >
                    End conversation
                  </button>
                  <button
                    className="btn btn-quiet"
                    onClick={call.toggleMute}
                    aria-pressed={call.muted}
                    disabled={status === "ending"}
                  >
                    {call.muted ? "Unmute microphone" : "Mute microphone"}
                  </button>
                </>
              )}
            </div>

            {call.error && (
              <div className="error" role="alert">
                <strong>{call.error.title}</strong>
                <span>{call.error.detail}</span>
              </div>
            )}
          </div>
        </div>

        <section className="transcript" aria-label="Conversation transcript">
          <h2>Conversation</h2>
          <div className="transcript-scroll" ref={scroller} aria-live="polite">
            {lines.length === 0 && !partial && (
              <p className="empty">
                {live
                  ? "The transcript appears here as soon as someone speaks."
                  : "Start the conversation and everything said on the call appears here."}
              </p>
            )}
            {lines.map((l) => (
              <p key={l.id} className={`line from-${l.role}`}>
                <span className="who">{l.role === "assistant" ? "Concierge" : "You"}</span>
                {l.text}
              </p>
            ))}
            {partial && (
              <p className={`line is-partial from-${partial.role}`}>
                <span className="who">{partial.role === "assistant" ? "Concierge" : "You"}</span>
                {partial.text}
              </p>
            )}
          </div>
        </section>
      </section>

      <section className="qualification" aria-labelledby="q-title">
        <div className="section-head">
          <h2 id="q-title">Qualification</h2>
          <p>{captured} of 4 checkpoints captured</p>
        </div>
        <Tracker qualification={shown} />
      </section>

      {status === "ended" && (
        <section className="summary" aria-labelledby="s-title">
          <div className="section-head">
            <h2 id="s-title">Lead summary</h2>
            <p>
              {formatDuration(duration)} call
              {reasonKey ? `, ${(ENDED_REASON[reasonKey] ?? humanize(reasonKey)).toLowerCase()}` : ""}
            </p>
          </div>

          <div className="summary-grid">
            <div className="summary-main">
              <h3>What was said</h3>
              {summary.phase === "loading" && (
                <p className="muted">Writing up the call. This can take up to a minute.</p>
              )}
              {summaryData?.summary && <p className="summary-text">{summaryData.summary}</p>}
              {summary.phase === "partial" && <p className="muted">{summary.reason}</p>}
              {rows.length > 0 && (
                <dl className="facts">
                  {rows.map((r, i) => (
                    <div key={i}>
                      <dt>{r.label}</dt>
                      <dd>{r.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>

            <div className="summary-side">
              <h3>Checkpoints</h3>
              <p className="score">
                {fits} of 4 fit{captured < 4 ? `, ${4 - captured} not discussed` : ""}
              </p>
              <dl className="facts">
                {CHECKPOINTS.map((k) => (
                  <div key={k}>
                    <dt>{CHECKPOINT_COPY[k].title}</dt>
                    <dd>
                      {shown[k].value ?? STATUS_COPY[shown[k].status]}
                      {shown[k].value && <span className="tag">{STATUS_COPY[shown[k].status]}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
              {summaryData && (summaryData.stored || summaryData.storageNote) && (
                <p className={`saved ${summaryData.stored ? "is-saved" : ""}`}>
                  {summaryData.stored ? "Saved to your leads database" : `Not saved. ${summaryData.storageNote ?? ""}`}
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      <footer className="foot">
        Built as an assessment demo. This is not an official Divyasree Developers website.
      </footer>
    </main>
  );
}
