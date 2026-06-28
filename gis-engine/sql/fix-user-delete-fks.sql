-- ════════════════════════════════════════════════════════════════════════
--  Unblock user deletion. Three foreign keys referenced profiles(id) with NO
--  ON DELETE clause (Postgres default = RESTRICT), so deleting a user who ever
--  created/was-assigned a field task — or registered a push device — failed with:
--    "update or delete on table profiles violates foreign key constraint
--     field_tasks_created_by_fkey on table field_tasks"
--
--  Deleting auth.users cascades to profiles (profiles.id REFERENCES
--  auth.users(id) ON DELETE CASCADE), so the profiles delete must be permitted
--  for the chain to complete. This switches the three blockers to:
--    - field_tasks       → SET NULL  (keep the task for history, clear the link)
--    - push_subscriptions → CASCADE  (a device token is useless once user is gone)
--
--  Idempotent — safe to re-run. RUN THIS ONCE in the Supabase SQL editor.
-- ════════════════════════════════════════════════════════════════════════

-- field_tasks: keep the task for history; clear the link to the deleted user
alter table public.field_tasks drop constraint if exists field_tasks_created_by_fkey;
alter table public.field_tasks add  constraint field_tasks_created_by_fkey
  foreign key (created_by)  references public.profiles(id) on delete set null;

alter table public.field_tasks drop constraint if exists field_tasks_assigned_to_fkey;
alter table public.field_tasks add  constraint field_tasks_assigned_to_fkey
  foreign key (assigned_to) references public.profiles(id) on delete set null;

-- push_subscriptions: a device push token is useless once the user is gone
alter table public.push_subscriptions drop constraint if exists push_subscriptions_user_id_fkey;
alter table public.push_subscriptions add  constraint push_subscriptions_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade;
