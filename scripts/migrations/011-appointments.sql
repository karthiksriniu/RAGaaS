-- 011: appointments - bookable resources, working hours, and the slot grid.
--
-- The one structural decision here is appointment_slots. A unique index on
-- (resource_id, starts_at) looks like it prevents double-booking, and does -
-- but only while every appointment shares a single duration. The moment
-- durations vary (per-service durations are a stated future want), a 60-minute
-- booking and a 30-minute one starting 30 minutes later both satisfy it and the
-- same stylist is booked twice.
--
-- So a booking is expanded into the 15-minute grid slots it occupies and the
-- constraint lives on those rows. A 60-minute booking writes four; any overlap
-- violates the primary key and the whole transaction rolls back.
--
-- That is deliberate for three reasons beyond correctness:
--   * atomic without SELECT-then-INSERT, which matters because this runs mid
--     call - see the latency note in /api/voice/retrieve (~1.65s warm, Virginia
--     to Tokyo). One round trip, not two.
--   * no btree_gist extension, unlike an exclusion constraint over tstzrange.
--   * per-service durations need no migration when they arrive.

create table if not exists resources (
  id text primary key,
  tenant_id text not null references tenants(id),
  name text not null,
  -- A label for the dashboard only - the booking logic treats every kind the
  -- same. 'table' exists so a restaurant reads naturally, not because tables
  -- behave differently from stylists.
  kind text not null default 'person',
  -- A table seats four; a stylist takes one at a time. Used by the agent to
  -- match a party size, never to allow two bookings in one slot.
  capacity int not null default 1,
  active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists resources_tenant_idx on resources (tenant_id, active, sort_order);

-- Opening hours, per resource, per weekday. Minutes from midnight IST.
--
-- The ABSENCE of a row means closed that weekday, so "shut on Sundays" needs no
-- null handling and no is_closed flag that can disagree with the times beside it.
--
-- closes_minute may exceed 1440 to express past midnight: a restaurant open
-- until 1am on Saturday is closes_minute 1500. Slot generation adds minutes to
-- that day's IST midnight, so this rolls over correctly with no special case.
create table if not exists resource_hours (
  tenant_id text not null references tenants(id),
  resource_id text not null references resources(id) on delete cascade,
  weekday int not null check (weekday between 0 and 6),   -- 0 = Sunday
  opens_minute int not null check (opens_minute >= 0 and opens_minute < 1440),
  closes_minute int not null check (closes_minute > 0 and closes_minute <= 1740),
  primary key (resource_id, weekday),
  check (closes_minute > opens_minute)
);

create table if not exists appointments (
  id text primary key,
  tenant_id text not null references tenants(id),
  resource_id text not null references resources(id),
  starts_at timestamptz not null,
  duration_minutes int not null,
  customer_name text,
  -- Read back to the caller before the booking is made, so this is the number
  -- they confirmed rather than whatever the carrier presented.
  customer_phone text not null,
  party_size int not null default 1,
  service text,
  notes text,
  status text not null default 'booked'
    check (status in ('booked', 'cancelled', 'completed', 'no_show')),
  source text not null default 'voice' check (source in ('voice', 'dashboard')),
  created_at timestamptz not null default now()
);

create index if not exists appointments_tenant_time_idx on appointments (tenant_id, starts_at);
create index if not exists appointments_resource_time_idx on appointments (resource_id, starts_at);

-- The guard. Rows are DELETED when an appointment is cancelled rather than
-- carrying a status, so the constraint never has to reason about one - a
-- cancelled booking simply stops occupying the grid.
create table if not exists appointment_slots (
  tenant_id text not null references tenants(id),
  appointment_id text not null references appointments(id) on delete cascade,
  resource_id text not null references resources(id) on delete cascade,
  slot_start timestamptz not null,
  primary key (resource_id, slot_start)
);

create index if not exists appointment_slots_lookup_idx
  on appointment_slots (tenant_id, slot_start);
create index if not exists appointment_slots_appointment_idx
  on appointment_slots (appointment_id);

-- Per-tenant configuration. Nullable/defaulted so this migration is safe ahead
-- of the code that reads it.
alter table tenants
  add column if not exists appointments_enabled boolean not null default false,
  -- 15, 30 or 60. One rule for the whole business, per the 5 Sep decision.
  add column if not exists appointment_default_minutes int not null default 30;

-- RLS, following 003 exactly. current_setting(..., true) yields NULL rather
-- than erroring when app.tenant_id was never set, and tenant_id = NULL is never
-- true - so a code path that forgets withTenant() gets zero rows, not somebody
-- else's bookings.
do $$
declare t text;
begin
  foreach t in array array['resources', 'resource_hours', 'appointments', 'appointment_slots']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format(
      'create policy tenant_isolation on %I using (tenant_id = current_setting(''app.tenant_id'', true)) with check (tenant_id = current_setting(''app.tenant_id'', true))',
      t);
  end loop;
end $$;

-- A new table is invisible to the non-owner app role without this; see the same
-- block in schema.sql.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    grant select, insert, update, delete on resources         to app_runtime;
    grant select, insert, update, delete on resource_hours    to app_runtime;
    grant select, insert, update, delete on appointments      to app_runtime;
    grant select, insert, update, delete on appointment_slots to app_runtime;
  end if;
end $$;
