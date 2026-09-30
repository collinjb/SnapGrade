-- SnapGrade schema.
--
-- Every table is owned by exactly one auth user (anonymous at first) and
-- locked down with row-level security, so the anon key shipped in the app can
-- only ever reach that user's own rows.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- assignments
-- ---------------------------------------------------------------------------
create table if not exists public.assignments (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  name             text not null default 'Assignment',
  answer_key_mode  text not null default 'ai'
                     check (answer_key_mode in ('ai', 'scan', 'typed')),
  answer_key_text  text,
  answer_key_path  text,
  archived         boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists assignments_user_created_idx
  on public.assignments (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- results  (one scanned page = one student's paper)
-- ---------------------------------------------------------------------------
create table if not exists public.results (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users (id) on delete cascade,
  assignment_id      uuid not null references public.assignments (id) on delete cascade,
  student_name       text not null default 'Student',
  total_earned       numeric(8, 2) not null default 0,
  total_possible     numeric(8, 2) not null default 0,
  needs_review_count integer not null default 0,
  -- Object path in the `scans` bucket; null when image upload is off.
  image_path         text,
  model              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists results_assignment_idx
  on public.results (assignment_id, created_at desc);
create index if not exists results_user_idx
  on public.results (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- problems  (one row per graded question)
-- ---------------------------------------------------------------------------
create table if not exists public.problems (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  result_id       uuid not null references public.results (id) on delete cascade,
  position        integer not null default 0,
  number          text not null default '',
  question_text   text not null default '',
  student_answer  text not null default '',
  correct_answer  text not null default '',
  status          text not null default 'needs_review'
                    check (status in ('correct', 'incorrect', 'partial', 'needs_review')),
  -- The teacher's manual verdict, which wins over `status` when set.
  override_status text check (override_status in ('correct', 'incorrect')),
  points_earned   numeric(8, 2) not null default 0,
  points_possible numeric(8, 2) not null default 1,
  explanation     text not null default '',
  confidence      real not null default 0 check (confidence >= 0 and confidence <= 1),
  -- { "x": 0..1, "y": 0..1, "w": 0..1, "h": 0..1 }
  bbox            jsonb not null default '{"x":0,"y":0,"w":0,"h":0}'::jsonb
);

create index if not exists problems_result_idx on public.problems (result_id, position);

-- ---------------------------------------------------------------------------
-- api_usage  (rate limiting + a simple cost ledger)
-- ---------------------------------------------------------------------------
create table if not exists public.api_usage (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  latency_ms    integer not null default 0,
  ok            boolean not null default true
);

create index if not exists api_usage_user_time_idx
  on public.api_usage (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists assignments_touch on public.assignments;
create trigger assignments_touch before update on public.assignments
  for each row execute function public.touch_updated_at();

drop trigger if exists results_touch on public.results;
create trigger results_touch before update on public.results
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Rate limiting
--
-- Called by the edge function with the service role. SECURITY DEFINER so it
-- can read the whole usage table while clients cannot, and it records the
-- attempt in the same statement to avoid a check-then-write race.
-- ---------------------------------------------------------------------------
create or replace function public.check_rate_limit(
  p_user          uuid,
  p_minute_limit  integer default 12,
  p_day_limit     integer default 400
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  minute_count integer;
  day_count    integer;
  usage_id     bigint;
begin
  select count(*) into minute_count
    from public.api_usage
   where user_id = p_user
     and created_at > now() - interval '1 minute';

  if minute_count >= p_minute_limit then
    return jsonb_build_object(
      'allowed', false, 'reason', 'minute', 'retry_after_seconds', 60
    );
  end if;

  select count(*) into day_count
    from public.api_usage
   where user_id = p_user
     and created_at > now() - interval '1 day';

  if day_count >= p_day_limit then
    return jsonb_build_object(
      'allowed', false, 'reason', 'day', 'retry_after_seconds', 3600
    );
  end if;

  -- Reserve the slot now; the edge function patches in token counts and the
  -- outcome afterwards using the id returned here.
  insert into public.api_usage (user_id) values (p_user) returning id into usage_id;

  return jsonb_build_object(
    'allowed', true,
    'usage_id', usage_id,
    'minute_remaining', p_minute_limit - minute_count - 1,
    'day_remaining', p_day_limit - day_count - 1
  );
end;
$$;

-- Only the edge function may call this: revoking from PUBLIC also removes the
-- implicit grant that service_role inherits, so grant it back explicitly.
revoke all on function public.check_rate_limit(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rate_limit(uuid, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
alter table public.assignments enable row level security;
alter table public.results     enable row level security;
alter table public.problems    enable row level security;
alter table public.api_usage   enable row level security;

drop policy if exists assignments_owner on public.assignments;
create policy assignments_owner on public.assignments
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists results_owner on public.results;
create policy results_owner on public.results
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists problems_owner on public.problems;
create policy problems_owner on public.problems
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Usage rows are written only by the edge function's service role. Clients may
-- read their own (for a "scans left today" indicator) but never write.
drop policy if exists api_usage_read_own on public.api_usage;
create policy api_usage_read_own on public.api_usage
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Storage: private `scans` bucket, one folder per user
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scans', 'scans', false, 8388608, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

-- Paths are `<user-id>/<assignment-id>/<result-id>.jpg`, so the first path
-- segment is the ownership check.
drop policy if exists scans_owner_read on storage.objects;
create policy scans_owner_read on storage.objects
  for select to authenticated
  using (bucket_id = 'scans' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists scans_owner_write on storage.objects;
create policy scans_owner_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'scans' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists scans_owner_update on storage.objects;
create policy scans_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'scans' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'scans' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists scans_owner_delete on storage.objects;
create policy scans_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'scans' and (storage.foldername(name))[1] = (select auth.uid())::text);
