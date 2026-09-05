-- 013: how far ahead a caller may book, and how soon.
--
-- Two rules that were previously absent, which meant the agent would happily
-- offer a slot five minutes from now (nobody can get there) or one in 2028
-- (nobody knows if they will still be open).
--
-- booking_lead_minutes is configurable rather than a constant even though it
-- was stated as "at least an hour": it is the same kind of rule as the window,
-- edited on the same screen, and a restaurant taking a table in twenty minutes
-- is as reasonable as a salon wanting two hours' notice.
alter table tenants
  add column if not exists booking_window_days int not null default 30,
  add column if not exists booking_lead_minutes int not null default 60;
