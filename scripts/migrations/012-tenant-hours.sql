-- 012: opening hours belong to the BUSINESS, with per-resource exceptions.
--
-- 011 put hours only on resources, which is backwards for how these businesses
-- actually work: a salon has opening hours, and one stylist who happens to work
-- Tuesday to Saturday is the exception, not the model. Making every resource
-- carry a full week meant a five-chair salon configured the same seven rows
-- five times and could drift.
--
-- Same encoding as resource_hours: absence of a row means closed that weekday,
-- and closes_minute may exceed 1440 to mean past midnight.
create table if not exists tenant_hours (
  tenant_id text not null references tenants(id),
  weekday int not null check (weekday between 0 and 6),   -- 0 = Sunday
  opens_minute int not null check (opens_minute >= 0 and opens_minute < 1440),
  closes_minute int not null check (closes_minute > 0 and closes_minute <= 1740),
  primary key (tenant_id, weekday),
  check (closes_minute > opens_minute)
);

-- RESOLUTION RULE, and it is deliberately all-or-nothing per resource: a
-- resource with ANY override rows uses only its own week; a resource with none
-- inherits the business's.
--
-- Not per-weekday fallback, which looks more flexible and is a trap. A stylist
-- who works Tuesday to Saturday has rows for those five days and none for
-- Sunday - and under per-weekday fallback that missing Sunday row would inherit
-- the salon's Sunday hours and book her on her day off. Absence has to keep
-- meaning closed for the resource that overrides.

do $$
begin
  execute 'alter table tenant_hours enable row level security';
  execute 'drop policy if exists tenant_isolation on tenant_hours';
  execute 'create policy tenant_isolation on tenant_hours using (tenant_id = current_setting(''app.tenant_id'', true)) with check (tenant_id = current_setting(''app.tenant_id'', true))';
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    grant select, insert, update, delete on tenant_hours to app_runtime;
  end if;
end $$;
