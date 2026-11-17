/**
 * The lead record and how it is produced.
 *
 * LEAD_OUTPUT is sent to Vapi with every call (see useVapiCall.ts). After the call,
 * Vapi runs it over the transcript and stores the result on the call record, so no
 * dashboard setup is needed for the summary or the lead fields.
 */

import type { CheckpointKey, Qualification } from "./qualification";

export interface Lead {
  intent: "self_use" | "investment" | "both" | null;
  geography_fit: boolean | null;
  budget: string | null;
  budget_fit: boolean | null;
  timeline_fit: boolean | null;
  objections: string[];
  follow_up_interest: boolean | null;
  callback_preference: string | null;
  lead_status: string | null;
}

const YES_NO = ["yes", "no", "unknown"];

// Vapi's schema accepts one type per field (no nulls), so "unknown" stands for "not said".
export const LEAD_OUTPUT = {
  type: "ai",
  name: "wow_lead_summary",
  description:
    "Summarise this outbound sales call about Whispers of the Wind villa plots near Nandi Hills " +
    "and extract the lead qualification. Use 'unknown' for anything the customer did not clearly say. Do not guess.",
  schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "Two to four sentences for a sales manager: what the customer wants, how they fit, any objections, and the agreed next step.",
      },
      intent: {
        type: "string",
        enum: ["self_use", "investment", "both", "unknown"],
        description: "Why the customer would buy: own use or weekend home, investment, or both.",
      },
      geography_fit: {
        type: "string",
        enum: YES_NO,
        description: "yes if comfortable with the Nandi Hills / Devanahalli corridor, no if not.",
      },
      budget: {
        type: "string",
        description: "The budget in the customer's own words, e.g. '1.2 crore'. 'unknown' if not stated.",
      },
      budget_fit: {
        type: "string",
        enum: YES_NO,
        description: "yes if the budget covers the 92.4 lakh starting price, no if clearly below it.",
      },
      timeline_fit: {
        type: "string",
        enum: YES_NO,
        description: "yes if comfortable with December 2029 possession and phased delivery, no if not.",
      },
      objections: {
        type: "array",
        items: { type: "string" },
        description: "Each concern the customer raised, one short phrase each. Empty if none.",
      },
      follow_up_interest: {
        type: "string",
        enum: YES_NO,
        description: "yes if the customer agreed to a call from a Property Expert, no if they declined.",
      },
      callback_preference: {
        type: "string",
        description: "When or how the customer wants to be called back, e.g. 'Saturday morning'. 'unknown' if not said.",
      },
    },
    required: [
      "summary",
      "intent",
      "geography_fit",
      "budget",
      "budget_fit",
      "timeline_fit",
      "objections",
      "follow_up_interest",
      "callback_preference",
    ],
  },
} as const;

const EMPTY = new Set(["", "unknown", "n/a", "na", "none", "null", "not discussed", "not mentioned"]);

function text(v: unknown, max = 300): string | null {
  if (v === null || v === undefined || typeof v === "object") return null;
  const s = String(v).trim();
  return EMPTY.has(s.toLowerCase()) ? null : s.slice(0, max);
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  const s = text(v)?.toLowerCase();
  if (!s) return null;
  if (["yes", "true", "fit", "comfortable", "agreed", "interested"].includes(s)) return true;
  if (["no", "false", "not fit", "not_a_fit", "declined", "not interested"].includes(s)) return false;
  return null;
}

function intent(v: unknown): Lead["intent"] {
  const s = text(v)?.toLowerCase().replace(/[-_]/g, " ") ?? "";
  const own = /self|own|personal|weekend|live/.test(s);
  const inv = s.includes("invest");
  if (s.includes("both") || (own && inv)) return "both";
  if (inv) return "investment";
  if (own) return "self_use";
  return null;
}

/** Same rule as the backend (backend/app/extract.py), so both always agree. */
export function leadStatus(l: Omit<Lead, "lead_status">): string {
  const fits = [l.budget_fit, l.geography_fit, l.timeline_fit];
  if (l.follow_up_interest === false) return "not_interested";
  if (l.budget_fit === false) return "not_qualified";
  if (fits.every((f) => f === true) && l.follow_up_interest === true) return "qualified";
  if (fits.every((f) => f === null)) return "incomplete";
  return "nurture";
}

export function normaliseLead(raw: Record<string, unknown>): Lead {
  const objections = Array.isArray(raw.objections)
    ? raw.objections
    : typeof raw.objections === "string"
      ? raw.objections.split(/[;\n]+/)
      : [];
  const base = {
    intent: intent(raw.intent),
    geography_fit: bool(raw.geography_fit),
    budget: text(raw.budget, 120),
    budget_fit: bool(raw.budget_fit),
    timeline_fit: bool(raw.timeline_fit),
    objections: [...new Set(objections.map((o) => text(o)).filter((o): o is string => Boolean(o)))],
    follow_up_interest: bool(raw.follow_up_interest),
    callback_preference: text(raw.callback_preference, 200),
  };
  const status = typeof raw.lead_status === "string" ? raw.lead_status : leadStatus(base);
  return { ...base, lead_status: status };
}

export function hasLeadData(l: Lead | null): boolean {
  if (!l) return false;
  return (
    l.intent !== null ||
    l.geography_fit !== null ||
    l.budget !== null ||
    l.budget_fit !== null ||
    l.timeline_fit !== null ||
    l.follow_up_interest !== null ||
    l.callback_preference !== null ||
    l.objections.length > 0
  );
}

/** Reads the summary and lead from a Vapi call record, wherever Vapi put them. */
export function extractFromCall(call: Record<string, any>): { summary: string | null; lead: Lead | null } {
  const merged: Record<string, unknown> = {};
  const outputs = call?.artifact?.structuredOutputs;
  if (outputs && typeof outputs === "object") {
    for (const out of Object.values(outputs as Record<string, any>)) {
      const result = out && typeof out === "object" && "result" in out ? out.result : out;
      if (result && typeof result === "object" && !Array.isArray(result)) Object.assign(merged, result);
    }
  }
  const legacy = call?.analysis?.structuredData;
  if (legacy && typeof legacy === "object") {
    for (const [k, v] of Object.entries(legacy)) if (!(k in merged)) merged[k] = v;
  }
  const summary = text(call?.analysis?.summary, 4000) ?? text(merged.summary, 4000);
  const lead = Object.keys(merged).length ? normaliseLead(merged) : null;
  return { summary, lead };
}

const INTENT_COPY = { self_use: "Own use or weekend home", investment: "Investment", both: "Own use and investment" };

/**
 * After the call, fills any checkpoint the live tracker missed using the post-call lead.
 * Checkpoints the assistant already recorded during the call are kept as they are.
 */
export function fillFromLead(q: Qualification, lead: Lead | null): Qualification {
  if (!lead) return q;
  const next = { ...q };
  const set = (key: CheckpointKey, fit: boolean | null, value: string | null) => {
    if (next[key].status !== "pending" || (fit === null && value === null)) return;
    next[key] = {
      status: fit === false ? "not_a_fit" : fit === true ? "confirmed" : "concern",
      value: value ?? undefined,
      fromSummary: true,
    };
  };
  if (lead.intent) set("intent", true, INTENT_COPY[lead.intent]);
  set("geography", lead.geography_fit, lead.geography_fit === null ? null : lead.geography_fit ? "Comfortable with the location" : "Not comfortable with the location");
  set("budget", lead.budget_fit, lead.budget);
  set("timeline", lead.timeline_fit, lead.timeline_fit === null ? null : lead.timeline_fit ? "Comfortable with December 2029" : "Not comfortable with December 2029");
  return next;
}
