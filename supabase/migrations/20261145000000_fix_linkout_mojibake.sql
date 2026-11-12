-- Repairs link-out headlines whose UTF-8 bytes were read as Windows-1252 by the publisher feed ("Chinatownâ€‘International").
-- Only link_out rows, only runs that round-trip cleanly (convert_to WIN1252, convert_from UTF8); anything else is left as is.
-- Idempotent: a repaired headline no longer matches. The ingest code now repairs new headlines (repairMojibake).
do $$
declare r record; v_fixed text;
begin
  for r in select id, headline from core.blurbs where kind = 'link_out' and headline ~ '[ÂÃâ][€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ¡-¿]' loop
    begin
      v_fixed := convert_from(convert_to(r.headline, 'WIN1252'), 'UTF8');
      if length(v_fixed) < length(r.headline) then
        update core.blurbs set headline = v_fixed where id = r.id;
      end if;
    exception when others then
      null;   -- mixed or invalid text: leave it
    end;
  end loop;
end $$;

-- Hide stored link-out junk that the new ingest filter (config.newsdata.offTopicPattern2) would now skip: crime items and
-- auto-generated fund-holding spam. Idempotent.
update core.blurbs set status = 'hidden', updated_at = now()
 where kind = 'link_out' and status in ('published', 'queued')
   and headline ~* '(arrested|stealing|stolen|burglar|murder|shooting)|shares? (sold|bought|purchased|acquired|trimmed|lifted|cut) by|head to head (comparison|survey)|how much .{0,40} owe';
