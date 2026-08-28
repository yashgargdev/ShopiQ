-- ============================================================================
-- ShopiQ Phase 2 — AI conversations, messages and tool audit log
-- ============================================================================
-- The AI never touches these tables directly. Server-side route handlers own
-- every write, exactly as they do for carts and orders.
--
-- `conversations.state` is the structured requirement state the agent carries
-- across turns (category, budget, use cases, preferences). It is deliberately
-- separate from the raw message text: follow-ups like "show me lighter ones"
-- are resolved against this object, not by re-reading the transcript.
-- ============================================================================

create table public.conversations (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid references public.customers(id) on delete cascade,
  -- Guests get an opaque token in an httpOnly cookie, same pattern as carts.
  session_token text,
  title         text,
  status        text not null default 'active' check (status in ('active', 'archived')),
  state         jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint conversations_owner_present
    check (customer_id is not null or session_token is not null)
);

create index conversations_customer_idx on public.conversations (customer_id, updated_at desc);
create index conversations_session_idx  on public.conversations (session_token)
  where session_token is not null;

create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------

create table public.conversation_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content         text not null default '',
  -- Assistant turns carry their product recommendations, scores and match
  -- reasons here, so a reloaded conversation renders exactly as it did live.
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

create index conversation_messages_conversation_idx
  on public.conversation_messages (conversation_id, created_at);

-- Keep the parent conversation's updated_at honest.
create or replace function public.touch_conversation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.conversations set updated_at = now()
   where id = coalesce(new.conversation_id, old.conversation_id);
  return null;
end;
$$;

create trigger conversation_messages_touch
  after insert on public.conversation_messages
  for each row execute function public.touch_conversation();

-- ---------------------------------------------------------------------------
-- Tool audit log: what the agent asked for, what the backend actually did.
-- Never client-readable — it is an operator/debugging surface.
-- ---------------------------------------------------------------------------

create table public.ai_tool_logs (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid references public.conversations(id) on delete cascade,
  message_id        uuid references public.conversation_messages(id) on delete set null,
  tool_name         text not null,
  input             jsonb not null default '{}'::jsonb,
  output            jsonb,
  status            text not null check (status in ('success', 'error', 'rejected')),
  error             text,
  execution_time_ms integer,
  created_at        timestamptz not null default now()
);

create index ai_tool_logs_conversation_idx on public.ai_tool_logs (conversation_id, created_at desc);
create index ai_tool_logs_tool_idx         on public.ai_tool_logs (tool_name, created_at desc);
create index ai_tool_logs_status_idx       on public.ai_tool_logs (status) where status <> 'success';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.conversations         enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.ai_tool_logs           enable row level security;

-- A signed-in shopper can read their own conversations. Guest conversations
-- carry customer_id IS NULL and are therefore invisible to every browser role;
-- only server code holding the service key can reach them.
create policy conversations_owner_read on public.conversations
  for select to authenticated
  using (customer_id is not null and customer_id = auth.uid());

create policy conversation_messages_owner_read on public.conversation_messages
  for select to authenticated
  using (exists (
    select 1 from public.conversations c
     where c.id = conversation_id
       and c.customer_id is not null
       and c.customer_id = auth.uid()
  ));

-- ai_tool_logs intentionally has RLS enabled and NO policy: no browser role can
-- read it. Merchants inspect it through a server route if that is ever needed.

revoke execute on function public.touch_conversation() from public, anon, authenticated;
