export const CHECKPOINTS = ["intent", "geography", "budget", "timeline"] as const;
export type CheckpointKey = (typeof CHECKPOINTS)[number];
export type CheckpointStatus = "pending" | "confirmed" | "concern" | "not_a_fit";

export interface Checkpoint {
  status: CheckpointStatus;
  value?: string;
  quote?: string;
  updatedAt?: number;
  /** True when filled from the post-call summary rather than live during the call. */
  fromSummary?: boolean;
}

export type Qualification = Record<CheckpointKey, Checkpoint>;

export const emptyQualification = (): Qualification => ({
  intent: { status: "pending" },
  geography: { status: "pending" },
  budget: { status: "pending" },
  timeline: { status: "pending" },
});

export const CHECKPOINT_COPY: Record<CheckpointKey, { title: string; question: string }> = {
  intent: { title: "Intent", question: "Own use or investment" },
  geography: { title: "Geography", question: "Comfort with the Nandi Hills corridor" },
  budget: { title: "Budget", question: "Fit with ₹92.4 lakh onwards" },
  timeline: { title: "Timeline", question: "Comfort with December 2029 possession" },
};

export const STATUS_COPY: Record<CheckpointStatus, string> = {
  pending: "Not yet discussed",
  confirmed: "Fits",
  concern: "Has concerns",
  not_a_fit: "Doesn't fit",
};

/** Validates the arguments of an `update_qualification` tool call sent by the assistant. */
export function parseQualificationArgs(
  raw: unknown
): { key: CheckpointKey; checkpoint: Checkpoint } | null {
  let args: unknown = raw;
  if (typeof raw === "string") {
    try {
      args = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const key = String(a.checkpoint ?? "").toLowerCase() as CheckpointKey;
  const status = String(a.status ?? "").toLowerCase() as CheckpointStatus;
  if (!CHECKPOINTS.includes(key)) return null;
  if (!["confirmed", "concern", "not_a_fit"].includes(status)) return null;
  return {
    key,
    checkpoint: {
      status,
      value: typeof a.value === "string" ? a.value.slice(0, 160) : undefined,
      quote: typeof a.quote === "string" ? a.quote.slice(0, 240) : undefined,
      updatedAt: Date.now(),
    },
  };
}
