"""Turns a Vapi end-of-call-report (or a call fetched from the Vapi API) into
two database rows: one for the call and one for the lead.

Every field is optional. Customers hang up early, skip questions, or answer vaguely,
so anything missing is stored as NULL and listed in `missing_fields`.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

LEAD_FIELDS = [
    "intent",
    "geography_fit",
    "budget",
    "budget_fit",
    "timeline_fit",
    "objections",
    "follow_up_interest",
    "callback_preference",
]

# Other names the model might use for the same field.
ALIASES = {
    "intent": ["intent", "purchase_intent", "buying_intent", "purpose"],
    "geography_fit": ["geography_fit", "geography", "location_fit", "geo_fit", "location_comfort"],
    "budget": ["budget", "budget_range", "stated_budget", "budget_amount"],
    "budget_fit": ["budget_fit", "budget_fitment", "budget_qualified"],
    "timeline_fit": ["timeline_fit", "timeline", "possession_fit", "timeline_comfort"],
    "objections": ["objections", "concerns", "objection"],
    "follow_up_interest": ["follow_up_interest", "followup_interest", "follow_up", "wants_follow_up", "callback_requested"],
    "callback_preference": ["callback_preference", "callback_time", "preferred_callback_time", "preferred_time"],
}

TRUE_WORDS = {"true", "yes", "y", "fit", "fits", "comfortable", "ok", "okay", "interested", "agreed", "confirmed", "1"}
FALSE_WORDS = {"false", "no", "n", "not fit", "not_a_fit", "not a fit", "uncomfortable", "not comfortable", "not interested", "declined", "0"}
EMPTY_WORDS = {"", "unknown", "n/a", "na", "none", "null", "not discussed", "not captured", "not mentioned", "unclear"}


def _snake(key: str) -> str:
    key = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key))
    return re.sub(r"[^a-z0-9]+", "_", key.lower()).strip("_")


def _as_dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def to_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in TRUE_WORDS:
        return True
    if text in FALSE_WORDS:
        return False
    return None


def to_text(value: Any, limit: int = 500) -> str | None:
    if value is None or isinstance(value, (dict, list)):
        return None
    text = str(value).strip()
    if text.lower() in EMPTY_WORDS:
        return None
    return text[:limit]


def to_intent(value: Any) -> str | None:
    text = (to_text(value) or "").lower().replace("-", " ").replace("_", " ")
    if not text:
        return None
    self_use = any(w in text for w in ["self", "own use", "personal", "weekend", "live", "end use"])
    invest = "invest" in text
    if "both" in text or (self_use and invest):
        return "both"
    if invest:
        return "investment"
    if self_use:
        return "self_use"
    return None


def to_objections(value: Any) -> list[str]:
    if value is None:
        return []
    items = value if isinstance(value, list) else re.split(r"[;\n]+", str(value))
    cleaned = []
    for item in items:
        text = to_text(item, 300)
        if text and text not in cleaned:
            cleaned.append(text)
    return cleaned[:20]


def collect_structured(source: dict) -> dict:
    """Gathers structured lead data from every place Vapi may put it:
    analysis.structuredData, and artifact.structuredOutputs ({id: {name, result}})."""
    found: dict[str, Any] = {}

    def absorb(obj: Any, name: str | None = None) -> None:
        if isinstance(obj, dict):
            for k, v in obj.items():
                found.setdefault(_snake(k), v)
        elif name is not None:
            found.setdefault(_snake(name), obj)

    for holder in (source, _as_dict(source.get("call"))):
        absorb(_as_dict(holder.get("analysis")).get("structuredData"))
        outputs = _as_dict(holder.get("artifact")).get("structuredOutputs")
        for output_id, output in _as_dict(outputs).items():
            if isinstance(output, dict) and "result" in output:
                absorb(output.get("result"), output.get("name") or output_id)
            else:
                absorb(output, output_id)
    return found


def _pick(data: dict, field: str) -> Any:
    for alias in ALIASES[field]:
        if alias in data and data[alias] is not None:
            return data[alias]
    return None


def derive_lead_status(lead: dict) -> str:
    """Deterministic rule so the same answers always give the same status.

    not_interested  customer declined a follow-up
    not_qualified   budget does not fit the starting price
    qualified       budget, geography and timeline all fit, and follow-up accepted
    incomplete      none of the three fit checks was captured
    nurture         everything else (partial answers or a non-budget concern)
    """
    fits = [lead.get("budget_fit"), lead.get("geography_fit"), lead.get("timeline_fit")]
    if lead.get("follow_up_interest") is False:
        return "not_interested"
    if lead.get("budget_fit") is False:
        return "not_qualified"
    if all(f is True for f in fits) and lead.get("follow_up_interest") is True:
        return "qualified"
    if all(f is None for f in fits):
        return "incomplete"
    return "nurture"


def finalize_lead(lead: dict) -> dict:
    """Recomputes the fields that depend on the others."""
    missing = [f for f in LEAD_FIELDS if f != "objections" and lead.get(f) is None]
    lead["missing_fields"] = missing
    lead["data_complete"] = not missing
    lead["lead_status"] = derive_lead_status(lead)
    return lead


def _message_lists(source: dict) -> list[list]:
    call = _as_dict(source.get("call"))
    lists = []
    for holder in (source, _as_dict(source.get("artifact")), call, _as_dict(call.get("artifact"))):
        for key in ("messages", "messagesOpenAIFormatted"):
            if isinstance(holder.get(key), list):
                lists.append(holder[key])
    return lists


def tool_call_checkpoints(source: dict) -> dict[str, dict]:
    """Reads the assistant's update_qualification tool calls from the call's message log.
    The latest call per checkpoint wins. Used to fill gaps the post-call summary left."""
    found: dict[str, dict] = {}

    def walk(node: Any) -> None:
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if not isinstance(node, dict):
            return
        fn = node.get("function")
        if isinstance(fn, dict) and fn.get("name") == "update_qualification" and "arguments" in fn:
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = None
            if isinstance(args, dict) and args.get("checkpoint") in ("intent", "geography", "budget", "timeline"):
                found[args["checkpoint"]] = args
            return
        for value in node.values():
            if isinstance(value, (list, dict)):
                walk(value)

    for messages in _message_lists(source):
        walk(messages)
    return found


def _status_fit(args: dict | None) -> bool | None:
    status = str((args or {}).get("status", "")).lower()
    return {"confirmed": True, "not_a_fit": False}.get(status)


def build_lead(call_id: str, source: dict) -> dict:
    data = collect_structured(source)
    lead = {
        "vapi_call_id": call_id,
        "intent": to_intent(_pick(data, "intent")),
        "geography_fit": to_bool(_pick(data, "geography_fit")),
        "budget": to_text(_pick(data, "budget"), 120),
        "budget_fit": to_bool(_pick(data, "budget_fit")),
        "timeline_fit": to_bool(_pick(data, "timeline_fit")),
        "objections": to_objections(_pick(data, "objections")),
        "follow_up_interest": to_bool(_pick(data, "follow_up_interest")),
        "callback_preference": to_text(_pick(data, "callback_preference"), 200),
    }

    # Fill anything the summary missed from what the assistant recorded live.
    checkpoints = tool_call_checkpoints(source)
    if lead["intent"] is None and "intent" in checkpoints:
        lead["intent"] = to_intent(checkpoints["intent"].get("value"))
    for field, key in (("geography_fit", "geography"), ("budget_fit", "budget"), ("timeline_fit", "timeline")):
        if lead[field] is None and key in checkpoints:
            lead[field] = _status_fit(checkpoints[key])
    if lead["budget"] is None and "budget" in checkpoints:
        lead["budget"] = to_text(checkpoints["budget"].get("value"), 120)
    if not lead["objections"]:
        lead["objections"] = [
            f"{key.capitalize()}: {to_text(args.get('value'), 200)}"
            for key, args in checkpoints.items()
            if str(args.get("status")) in ("concern", "not_a_fit") and to_text(args.get("value"))
        ]
    return finalize_lead(lead)


def merge_lead(existing: dict | None, incoming: dict) -> dict:
    """A retried or late webhook must never erase data already stored.
    New non-empty values win; empty values keep what was there."""
    if not existing:
        return incoming
    merged = dict(incoming)
    for field in LEAD_FIELDS:
        new, old = incoming.get(field), existing.get(field)
        if field == "objections":
            merged[field] = new if new else (old or [])
        elif new is None:
            merged[field] = old
    return finalize_lead(merged)


def _iso(value: Any) -> str | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).isoformat()
    except ValueError:
        return None


def build_call(call_id: str, source: dict) -> dict:
    """`source` is the webhook `message`, or a call object from the Vapi API."""
    call = _as_dict(source.get("call")) or source
    artifact = _as_dict(source.get("artifact")) or _as_dict(call.get("artifact"))
    analysis = _as_dict(source.get("analysis")) or _as_dict(call.get("analysis"))
    customer = _as_dict(source.get("customer")) or _as_dict(call.get("customer"))

    started = _iso(source.get("startedAt") or call.get("startedAt"))
    ended = _iso(source.get("endedAt") or call.get("endedAt"))
    duration = source.get("durationSeconds")
    if duration is None and started and ended:
        duration = (datetime.fromisoformat(ended) - datetime.fromisoformat(started)).total_seconds()

    messages = artifact.get("messages") or source.get("messages")
    recording = _as_dict(artifact.get("recording"))

    return {
        "vapi_call_id": call_id,
        "assistant_id": call.get("assistantId"),
        "call_type": call.get("type"),
        "customer_number": to_text(customer.get("number"), 40),
        "customer_name": to_text(customer.get("name"), 120),
        "started_at": started,
        "ended_at": ended,
        "duration_seconds": round(float(duration)) if isinstance(duration, (int, float)) else None,
        "ended_reason": to_text(source.get("endedReason") or call.get("endedReason"), 120),
        "transcript": artifact.get("transcript") or source.get("transcript"),
        "messages": messages if isinstance(messages, list) else None,
        "summary": to_text(
            analysis.get("summary") or source.get("summary") or collect_structured(source).get("summary"), 4000
        ),
        "recording_url": artifact.get("recordingUrl") or source.get("recordingUrl") or recording.get("stereoUrl") or recording.get("url"),
    }


def merge_call(existing: dict | None, incoming: dict) -> dict:
    if not existing:
        return incoming
    return {k: (v if v is not None else existing.get(k)) for k, v in incoming.items()}
