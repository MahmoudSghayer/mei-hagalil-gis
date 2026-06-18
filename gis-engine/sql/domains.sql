-- ════════════════════════════════════════════════════════════════════════
--  Shared coded-value domains (B2) — org-wide code→label maps for attribute
--  fields (Status, Material, ValveType, …). Replaces the per-browser
--  localStorage overrides in js/gis-domains.js with a shared, admin-editable
--  source of truth. RUN THIS ONCE in the Supabase SQL editor.
-- ════════════════════════════════════════════════════════════════════════
create table if not exists public.gis_domains (
  field text not null,
  code  text not null,
  label text not null,
  primary key (field, code)
);

alter table public.gis_domains enable row level security;

-- read: any signed-in user (so labels render for everyone)
drop policy if exists gis_domains_read on public.gis_domains;
create policy gis_domains_read on public.gis_domains
  for select to authenticated using (true);

-- write: admins only
drop policy if exists gis_domains_write on public.gis_domains;
create policy gis_domains_write on public.gis_domains
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- seed the codes we are confident about (assumed standard schema — edit in-app)
insert into public.gis_domains (field, code, label) values
  ('Status','0','לא ידוע / מתוכנן'), ('Status','1','קיים / פעיל'), ('Status','4','מבוטל / נטוש'),
  ('Enabled','0','מנותק'), ('Enabled','1','מחובר'),
  ('NormalPosi','1','פתוח'), ('NormalPosi','2','סגור'),
  ('Operable','0','לא'), ('Operable','1','כן')
on conflict (field, code) do nothing;
