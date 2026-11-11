-- Drip release scales with the queue (M9c fix, 2026-11-11): at one card per 15 minutes a busy day (earnings season: dozens of
-- cards an hour) would let held cards expire unseen. The release now takes ceil(queued / (half the expiry in slots)) cards per
-- run, never fewer than max_per_release. With the defaults (8 h expiry, 15 min slots) that is 1 card per run while 16 or fewer
-- are queued, 3 per run at 46. Idempotent (create or replace).

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
  v_n   int;
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
    -- a deep queue is released faster, so held cards go live well before they expire (no hard-coded rate):
    -- clear the queue in about half the expiry time; a short queue still gets max_per_release per slot
    select count(*) into v_n from core.blurbs where status = 'queued';
    v_lim := greatest(c.max_per_release, ceil(v_n / greatest(1.0, (c.expire_hours * 60.0 / c.interval_minutes) / 2.0))::int);
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
