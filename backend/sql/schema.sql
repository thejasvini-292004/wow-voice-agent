-- Run once in the Supabase SQL editor.

create table if not exists public.calls (
  vapi_call_id     text primary key,          -- Vapi's call ID: the deduplication key
  assistant_id     text,
  call_type        text,                      -- webCall, outboundPhoneCall, ...
  customer_number  text,
  customer_name    text,
  started_at       timestamptz,
  ended_at         timestamptz,
  duration_seconds integer,
  ended_reason     text,
  transcript       text,
  messages         jsonb,
  summary          text,
  recording_url    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.leads (
  vapi_call_id        text primary key references public.calls (vapi_call_id) on delete cascade,
  intent              text check (intent in ('self_use', 'investment', 'both')),
  geography_fit       boolean,
  budget              text,
  budget_fit          boolean,
  timeline_fit        boolean,
  objections          text[] not null default '{}',
  follow_up_interest  boolean,
  callback_preference text,
  lead_status         text not null default 'incomplete'
                      check (lead_status in ('qualified', 'nurture', 'not_qualified', 'not_interested', 'incomplete')),
  data_complete       boolean not null default false,
  missing_fields      text[] not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists leads_status_created_idx on public.leads (lead_status, created_at desc);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists calls_touch on public.calls;
create trigger calls_touch before update on public.calls
for each row execute function public.touch_updated_at();

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
for each row execute function public.touch_updated_at();

-- Lock both tables. With row level security on and no policies, the public (anon)
-- key can read nothing; only this backend's service role key can read and write.
alter table public.calls enable row level security;
alter table public.leads enable row level security;
