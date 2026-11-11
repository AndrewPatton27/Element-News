-- M9c cadence: publication smoother ("drip"). Written, NOT applied. Idempotent. Needs no secret.
--
-- Problem (R-520): cards arrive in bursts (one run publishes 5, the next 6 hours publish none). Readers see a feed that
-- moves 1 time in 4-9 hours. Goal (Drew): at least one new, important card every 15 minutes in market hours.
--
-- What this does, in plain words:
--   1. During drip hours (06:00-20:00 ET, Monday to Friday, setting core.drip_config) a NEW card is HELD in status
--      'queued' when another card went live less than interval_minutes (15) ago or the queue is not empty.
--      Otherwise it goes live at once (a quiet feed is never delayed).
--   2. Never held (published at once): data cards (CPI, jobs, GDP, Treasury, Fed releases), event_type in
--      breaking_event_types ('fed', 'macro_release'), AI relevance >= breaking_relevance (5), cards whose own time is older
--      than fresh_hours (backfills and history), and any card outside the drip window.
--   3. core.release_queued_cards() runs every 15 minutes (cron job element-release-queue, see
--      20261142000100_cadence_cron.sql). In the window it releases at most max_per_release (1) queued card, the most
--      important first (importance, then oldest), and only if no card went live in the last interval_minutes minus 1.
--      Outside the window it releases everything. Cards queued longer than expire_hours (8) are hidden: stale news.
--   4. A released card gets published_at = now. Its sort_at becomes now too, EXCEPT link_out cards, which keep the source
--      time (so the 12 h delay still makes them sink, rule 7 / D-05). Feed ordering by sort_at stays correct.
-- Status 'queued' is invisible to every feed, search, company and brief query (they all test status = 'published').
-- api.publish_blurb is NOT rewritten (a BEFORE INSERT trigger decides); it still answers 'published' for a held card.
-- Off switch:  update core.drip_config set enabled = false where id;   (queued cards are released by the next cron run)
-- Check:       select status, count(*) from core.blurbs where status in ('queued') group by 1;
-- Settings are recorded in context/settings.md.

-- 1. status accepts 'queued'; queued_at says when the card was held
alter table core.blurbs drop constraint if exists blurbs_status_check;
alter table core.blurbs add constraint blurbs_status_check check (status in ('published', 'hidden', 'queued'));
alter table core.blurbs add column if not exists queued_at timestamptz;
create index if not exists blurbs_queued_idx on core.blurbs (importance desc, queued_at) where status = 'queued';

-- 2. settings: one row
create table if not exists core.drip_config (
  id                   boolean primary key default true check (id),
  enabled              boolean  not null default true,
  interval_minutes     int      not null default 15  check (interval_minutes between 1 and 240),
  window_start_hour_et int      not null default 6   check (window_start_hour_et between 0 and 23),
  window_end_hour_et   int      not null default 20  check (window_end_hour_et between 1 and 24),
  weekdays_only        boolean  not null default true,
  max_per_release      int      not null default 1   check (max_per_release between 1 and 20),
  expire_hours         int      not null default 8   check (expire_hours between 1 and 72),
  fresh_hours          int      not null default 36  check (fresh_hours between 1 and 720),
  breaking_event_types text[]   not null default array['fed', 'macro_release'],
  breaking_relevance   int      not null default 5   check (breaking_relevance between 1 and 6)
);
insert into core.drip_config (id) values (true) on conflict (id) do nothing;
alter table core.drip_config enable row level security;     -- no policies: private
revoke all on core.drip_config from public, anon, authenticated;

-- 3. is this moment inside the drip window (New York time)?
create or replace function core.drip_in_window(p_at timestamptz)
returns boolean
language sql stable set search_path = ''
as $$
  select (not c.weekdays_only or extract(isodow from p_at at time zone 'America/New_York') between 1 and 5)
     and extract(hour from p_at at time zone 'America/New_York') >= c.window_start_hour_et
     and extract(hour from p_at at time zone 'America/New_York') <  c.window_end_hour_et
    from core.drip_config c where c.id
$$;
revoke all on function core.drip_in_window(timestamptz) from public, anon, authenticated;

-- 4. BEFORE INSERT: hold the card or let it through
create or replace function core.blurbs_drip_hold()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  c core.drip_config%rowtype;
begin
  if new.status is distinct from 'published' then return new; end if;
  select * into c from core.drip_config where id;
  if not found or not c.enabled then return new; end if;
  if not core.drip_in_window(now()) then return new; end if;
  -- breaking and history: never held
  if new.kind = 'data'
     or new.event_type = any (c.breaking_event_types)
     or coalesce(new.everyday_relevance, 0) >= c.breaking_relevance
     or new.sort_at < now() - make_interval(hours => c.fresh_hours) then
    return new;
  end if;
  if exists (select 1 from core.blurbs b where b.status = 'queued')
     or exists (select 1 from core.blurbs b
                 where b.status = 'published' and b.published_at > now() - make_interval(mins => c.interval_minutes)) then
    new.status := 'queued';
    new.queued_at := now();
  end if;
  return new;
end;
$$;
revoke all on function core.blurbs_drip_hold() from public, anon, authenticated;
drop trigger if exists blurbs_drip_hold on core.blurbs;
create trigger blurbs_drip_hold before insert on core.blurbs
  for each row execute function core.blurbs_drip_hold();

-- 5. release job (cron every 15 minutes). Returns how many cards went live.
create or replace function core.release_queued_cards(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  c     core.drip_config%rowtype;
  v_lim int;
  v_ids uuid[];
  v_id  uuid;
begin
  select * into c from core.drip_config where id;
  if not found then return 0; end if;

  update core.blurbs set status = 'hidden', updated_at = p_now
   where status = 'queued' and queued_at < p_now - make_interval(hours => c.expire_hours);

  if c.enabled and core.drip_in_window(p_now) then
    -- a card went live within the last interval (minus one minute of cron slack): wait for the next run
    if exists (select 1 from core.blurbs b
                where b.status = 'published'
                  and b.published_at > p_now - make_interval(secs => c.interval_minutes * 60 - 60)) then
      return 0;
    end if;
    v_lim := c.max_per_release;
  else
    v_lim := 1000;                                   -- off hours or switched off: let everything out
  end if;

  select coalesce(array_agg(x.id), '{}') into v_ids from (
    select b.id from core.blurbs b where b.status = 'queued'
     order by b.importance desc, b.queued_at asc, b.id
     limit v_lim for update skip locked) x;

  foreach v_id in array v_ids loop
    update core.blurbs
       set status = 'published', published_at = p_now,
           sort_at = case when kind = 'link_out' then sort_at else greatest(sort_at, p_now) end,
           updated_at = p_now
     where id = v_id;
    perform core.refresh_rank(v_id);
  end loop;
  return coalesce(array_length(v_ids, 1), 0);
end;
$$;
revoke all on function core.release_queued_cards(timestamptz) from public, anon, authenticated;
grant execute on function core.release_queued_cards(timestamptz) to service_role;

-- 6. headlines of live AND queued cards (the link-out near-duplicate check must see held cards too). Service role only.
create or replace function api.recent_headlines(p_limit int default 150)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(h.headline), '[]'::jsonb) from (
    select b.headline from core.blurbs b
     where b.status in ('published', 'queued') and b.sort_at > now() - interval '3 days'
     order by b.sort_at desc limit least(greatest(p_limit, 1), 300)) h
$$;
revoke execute on function api.recent_headlines(int) from public, anon, authenticated;
grant  execute on function api.recent_headlines(int) to service_role;
