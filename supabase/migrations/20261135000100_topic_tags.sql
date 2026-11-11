-- Topic tags for the finer topics (wave 2, A-12 / D-121). NOT applied to prod. Idempotent.
--
-- core.topic_tags_of(headline, body, category) returns the finer topics a card's words match, in a fixed order:
-- rates, housing, trade, labor, banks, retirement (macro topics) and crypto, tech-ai (opt-in lanes, D-121).
-- It mirrors the on-device rules in lib/topics/fineTopics.ts (keep the two lists in step; the app tags on the device
-- today, so nothing depends on this function yet). A recall (category 'safety') never carries a macro topic.
--
-- Safety: pure function (immutable, no table access), search_path empty, private: execute is revoked from
-- public/anon/authenticated and granted to the service role only, so it is not part of the exposed api schema.
-- Lane cards must still pass the source rule in the app and in ranking: public-domain or filing text only, never a
-- link-out, and never Trending unless macro-material (D-121).
create or replace function core.topic_tags_of(p_headline text, p_body text, p_category text)
returns text[] language sql immutable parallel safe set search_path = '' as $$
  with t as (select coalesce(p_headline, '') || ' . ' || coalesce(p_body, '') as s, coalesce(p_category, '') as c)
  select coalesce(array_remove(array[
    case when c <> 'safety' and s ~* '\m(the fed|treasury yields?|10-?year|2-?year|yield curve|fed funds|federal reserve|fomc|interest rates?|rate (cut|hike|decision)s?|basis points?|bond yields?)\M' then 'rates' end,
    case when c <> 'safety' and s ~* '\m(housing|mortgages?|home (sales|prices?|buyers?)|existing-home|new-home|housing starts|rents?|case-shiller|homeowners?|foreclosures?)\M' then 'housing' end,
    case when c <> 'safety' and s ~* '\m(tariffs?|trade (deficit|surplus|war|deal|talks)|imports?|exports?|customs|trade balance)\M' then 'trade' end,
    case when c <> 'safety' and s ~* '\m(jobs? report|payrolls?|unemployment|jobless|labor (market|force|department)|wages?|job openings|jolts|layoffs?|hiring|employment)\M' then 'labor' end,
    case when c <> 'safety' and s ~* '\m(banks?|banking|lenders?|fdic|deposits?|credit unions?)\M' then 'banks' end,
    case when c <> 'safety' and s ~* '(\m401 ?\(?k\)?|\mira\M|\mretirement\M|\msocial security\M|\mpensions?\M|\mmedicare\M|\mannuit(y|ies)\M)' then 'retirement' end,
    case when s ~* '\m(bitcoin|crypto(currenc(y|ies))?|ethereum|stablecoins?|digital assets?)\M' then 'crypto' end,
    case when s ~ '(\mAI\M|[Aa]rtificial intelligence|[Ss]emiconductors?|\m[Cc]hips?\M|[Dd]ata cent(er|re)s?|[Mm]achine learning)' then 'tech-ai' end
  ], null), '{}'::text[]) from t;
$$;

revoke all on function core.topic_tags_of(text, text, text) from public, anon, authenticated;
grant execute on function core.topic_tags_of(text, text, text) to service_role;
