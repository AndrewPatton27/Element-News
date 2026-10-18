# supabase/maintenance

One-off SQL scripts that fix data in a live project. They are **not** migrations: `supabase db reset` does not run them. Paste one into the Supabase SQL editor when it is needed.

| File | What it does | Undo |
|---|---|---|
| `hide_offtopic_2026-10-17.sql` | Sets `core.blurbs.status = 'hidden'` for published cards the new topic rules would not have produced: SEC cards with no watch-list ticker, Costco's bonus-criteria filing, off-topic Federal Register rules (keeps the IRS card-payment and DOT airline-delay rules) and two Fed items (small-bank enforcement, discount-rate minutes). Saves the hidden ids in `core.maint_hidden_20261017` (RLS on, no public access). Safe to run twice. | Commented UNDO block at the end of the file: restores exactly the saved ids and drops the table. |

Before running, use the PREVIEW note in the file to list what would be hidden. Federal Register and Fed matches use headline text, so check the preview against the live feed.
