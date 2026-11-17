"""Database access. The API talks to this small interface, so tests can swap
Supabase for an in-memory store."""

from __future__ import annotations

from typing import Protocol

LEAD_COLUMNS = (
    "vapi_call_id,intent,geography_fit,budget,budget_fit,timeline_fit,objections,"
    "follow_up_interest,callback_preference,lead_status,data_complete,missing_fields,"
    "created_at,updated_at"
)
CALL_SUMMARY_COLUMNS = "customer_number,customer_name,started_at,duration_seconds,ended_reason,summary"


class LeadRepository(Protocol):
    def get_call(self, call_id: str) -> dict | None: ...
    def get_lead(self, call_id: str) -> dict | None: ...
    def upsert_call(self, row: dict) -> None: ...
    def upsert_lead(self, row: dict) -> None: ...
    def list_leads(self, lead_status: str | None, limit: int, offset: int) -> list[dict]: ...
    def get_lead_detail(self, call_id: str) -> dict | None: ...


class SupabaseLeadRepository:
    def __init__(self, url: str, service_role_key: str) -> None:
        from supabase import create_client

        self._db = create_client(url, service_role_key)

    def _one(self, table: str, call_id: str, columns: str = "*") -> dict | None:
        res = self._db.table(table).select(columns).eq("vapi_call_id", call_id).limit(1).execute()
        return res.data[0] if res.data else None

    def get_call(self, call_id: str) -> dict | None:
        return self._one("calls", call_id)

    def get_lead(self, call_id: str) -> dict | None:
        return self._one("leads", call_id)

    # vapi_call_id is the primary key of both tables. An upsert on it means a
    # retried webhook updates the existing row instead of creating a second one.
    def upsert_call(self, row: dict) -> None:
        self._db.table("calls").upsert(row, on_conflict="vapi_call_id").execute()

    def upsert_lead(self, row: dict) -> None:
        self._db.table("leads").upsert(row, on_conflict="vapi_call_id").execute()

    def list_leads(self, lead_status: str | None, limit: int, offset: int) -> list[dict]:
        query = self._db.table("leads").select(f"{LEAD_COLUMNS},calls({CALL_SUMMARY_COLUMNS})")
        if lead_status:
            query = query.eq("lead_status", lead_status)
        res = query.order("created_at", desc=True).range(offset, offset + limit - 1).execute()
        return res.data or []

    def get_lead_detail(self, call_id: str) -> dict | None:
        res = (
            self._db.table("leads")
            .select(f"{LEAD_COLUMNS},calls({CALL_SUMMARY_COLUMNS},transcript,messages,recording_url)")
            .eq("vapi_call_id", call_id)
            .limit(1)
            .execute()
        )
        return res.data[0] if res.data else None
