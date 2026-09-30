-- Review against your existing Mimo schema before running. Not applied by this repository.
-- Uses only public.ai_usage and public.ai_processing_jobs. No changes to Auth settings.
begin;
create table if not exists public.ai_usage (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 fingerprint text not null, status text not null default 'reserved' check(status in ('reserved','completed','failed')),
 provider text, model text, input_tokens integer not null default 0, output_tokens integer not null default 0,
 created_at timestamptz not null default now(), finished_at timestamptz
);
create index if not exists ai_usage_user_created on public.ai_usage(user_id,created_at);
create table if not exists public.ai_processing_jobs (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id) on delete cascade,
 save_id uuid not null, status text not null default 'queued' check(status in ('queued','processing','completed','failed')),
 attempts integer not null default 0, result jsonb, error_code text,
 lease_token uuid, lease_until timestamptz, available_at timestamptz not null default now(),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index if not exists ai_jobs_active_save on public.ai_processing_jobs(user_id,save_id) where status in ('queued','processing');
create index if not exists ai_jobs_poll on public.ai_processing_jobs(status,available_at);
alter table public.ai_usage enable row level security;
alter table public.ai_processing_jobs enable row level security;
-- All access through the authenticated backend, which always scopes by user_id.
revoke all on public.ai_usage,public.ai_processing_jobs from anon,authenticated;
grant select,insert,update on public.ai_usage,public.ai_processing_jobs to service_role;
create or replace function public.mimo_ai_usage_reserve(p_user_id uuid,p_fingerprint text,p_daily_limit integer)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,0));
 if p_daily_limit<1 or (select count(*) from public.ai_usage where user_id=p_user_id and created_at>=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') >= p_daily_limit then
  raise exception 'quota exceeded';
 end if;
 if exists(select 1 from public.ai_usage where user_id=p_user_id and fingerprint=p_fingerprint and status='reserved' and created_at>now()-interval '5 minutes') then
  raise exception 'duplicate pending';
 end if;
 insert into public.ai_usage(user_id,fingerprint) values(p_user_id,p_fingerprint) returning id into v_id;
 return v_id;
end; $$;
create or replace function public.mimo_ai_job_enqueue(p_user_id uuid,p_save_id uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.ai_processing_jobs;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text||p_save_id::text,0));
 select * into v_job from public.ai_processing_jobs where user_id=p_user_id and save_id=p_save_id and status in ('queued','processing') limit 1;
 if not found then insert into public.ai_processing_jobs(user_id,save_id) values(p_user_id,p_save_id) returning * into v_job; end if;
 return to_jsonb(v_job);
end; $$;
create or replace function public.mimo_ai_job_claim(p_lease_ms integer,p_max_attempts integer)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.ai_processing_jobs;
begin
 update public.ai_processing_jobs set status='failed',error_code='RETRY_EXHAUSTED',updated_at=now(),lease_token=null,lease_until=null
 where status='processing' and lease_until<now() and attempts>=p_max_attempts;
 select * into v_job from public.ai_processing_jobs
 where attempts<p_max_attempts and ((status='queued' and available_at<=now()) or (status='processing' and lease_until<now()))
 order by created_at for update skip locked limit 1;
 if not found then return null; end if;
 update public.ai_processing_jobs set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+p_lease_ms*interval '1 millisecond',updated_at=now()
 where id=v_job.id returning * into v_job;
 return to_jsonb(v_job);
end; $$;
create or replace function public.mimo_ai_job_finish(p_job_id uuid,p_lease_token uuid,p_result jsonb,p_error_code text,p_max_attempts integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update public.ai_processing_jobs set
 status=case when p_error_code is null then 'completed' when attempts>=p_max_attempts then 'failed' else 'queued' end,
 result=p_result,error_code=p_error_code,lease_token=null,lease_until=null,updated_at=now(),
 available_at=now()+least(attempts*30,300)*interval '1 second'
 where id=p_job_id and lease_token=p_lease_token and status='processing';
 if not found then raise exception 'job lease lost'; end if;
end; $$;
revoke all on function public.mimo_ai_usage_reserve(uuid,text,integer),public.mimo_ai_job_enqueue(uuid,uuid),public.mimo_ai_job_claim(integer,integer),public.mimo_ai_job_finish(uuid,uuid,jsonb,text,integer) from public,anon,authenticated;
grant execute on function public.mimo_ai_usage_reserve(uuid,text,integer),public.mimo_ai_job_enqueue(uuid,uuid),public.mimo_ai_job_claim(integer,integer),public.mimo_ai_job_finish(uuid,uuid,jsonb,text,integer) to service_role;
commit;
