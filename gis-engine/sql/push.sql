-- ════════════════════════════════════════════════════════════════════════
--  Web Push subscriptions (C4). Stores each device's push subscription per
--  user. A backend Edge Function (VAPID private key + web-push) reads this to
--  send pushes on assignment/approval. RUN THIS ONCE in the Supabase SQL editor.
-- ════════════════════════════════════════════════════════════════════════
create table if not exists public.push_subscriptions (
  endpoint     text primary key,
  user_id      uuid references public.profiles(id),
  subscription jsonb not null,
  created_at   timestamptz default now()
);

alter table public.push_subscriptions enable row level security;

-- a user manages only their own device subscriptions
drop policy if exists push_sub_self on public.push_subscriptions;
create policy push_sub_self on public.push_subscriptions for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- NOTE: the sender (Edge Function) reads all rows with the service-role key,
-- which bypasses RLS — no extra read policy needed for dispatch.
