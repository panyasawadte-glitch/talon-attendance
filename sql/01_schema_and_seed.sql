-- ใช้เฉพาะตอนตั้งระบบใหม่ในโปรเจกต์ Supabase ที่ยังว่างเปล่า
-- (ถ้าระบบเดิมทำงานอยู่แล้ว ไม่ต้องรันไฟล์นี้ซ้ำ)

create table branches (
  id int generated always as identity primary key,
  name text not null,
  lat double precision,
  lng double precision,
  radius_m int not null default 150,
  active boolean not null default true
);

create table employees (
  id int generated always as identity primary key,
  name text not null,
  type text not null default 'regular' check (type in ('regular','floater')),
  home_branch_id int references branches(id),
  pin_hash text,
  device_id text,
  active boolean not null default true
);

create table attendance (
  id bigint generated always as identity primary key,
  employee_id int not null references employees(id),
  branch_id int not null references branches(id),
  action text not null check (action in ('in','out')),
  server_time timestamptz not null default now(),
  lat double precision,
  lng double precision,
  accuracy_m double precision,
  challenge text,
  photo_path text,
  photo_hash text,
  device_id text,
  flags text[] not null default '{}',
  status text not null default 'ok' check (status in ('ok','flagged','approved','rejected')),
  note text
);

create view shifts with (security_invoker = true) as
select
  t.employee_id,
  t.branch_id,
  t.server_time as check_in,
  case when t.next_action = 'out' then t.next_time end as check_out,
  case when t.next_action = 'out'
    then round((extract(epoch from (t.next_time - t.server_time)) / 3600)::numeric, 2)
  end as hours
from (
  select a.*,
    lead(a.action) over w as next_action,
    lead(a.server_time) over w as next_time
  from attendance a
  where a.status <> 'rejected'
  window w as (partition by a.employee_id order by a.server_time)
) t
where t.action = 'in';

create view payroll_report with (security_invoker = true) as
select
  e.name as employee,
  (s.check_in at time zone 'Asia/Bangkok')::date as work_date,
  b.name as branch,
  to_char(s.check_in at time zone 'Asia/Bangkok', 'HH24:MI') as time_in,
  to_char(s.check_out at time zone 'Asia/Bangkok', 'HH24:MI') as time_out,
  s.hours
from shifts s
join employees e on e.id = s.employee_id
join branches b on b.id = s.branch_id;

alter table branches enable row level security;
alter table employees enable row level security;
alter table attendance enable row level security;
revoke all on all tables in schema public from anon, authenticated;

insert into storage.buckets (id, name, public)
values ('selfies', 'selfies', false)
on conflict do nothing;

-- Replace these sample coordinates with your own branch locations.
insert into branches (id, name, lat, lng) overriding system value values
  (1, 'Demo Branch A', 13.7563, 100.5018),
  (2, 'Demo Branch B', 13.7367, 100.5231);
select setval(pg_get_serial_sequence('branches', 'id'), 2);

insert into employees (name, type, home_branch_id) values
  ('Demo Employee A', 'regular', 1),
  ('Demo Employee B', 'regular', 2),
  ('Demo Floater', 'floater', null);
