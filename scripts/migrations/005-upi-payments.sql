-- 005: ₹999 UPI payments, provisional licensing and renewal.
--
-- Two new tables, both deliberately NOT RLS-scoped for the same reason
-- `tenants` isn't: payment_orders is read BEFORE any session or tenant exists
-- (keyed by the OTP-verified mobile, during signup), and platform_settings is
-- platform configuration rather than tenant content.
--
-- Reversible: drop both tables. Nothing existing is altered, and the app falls
-- back to env vars and its compiled defaults when platform_settings is absent.

create table if not exists platform_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Seeded so a fresh environment has a working configuration without anyone
-- opening the admin page first. The VPA is editable at /admin - it is the one
-- value here that changes when the money should land somewhere else.
insert into platform_settings (key, value) values
  ('upi_vpa', 'karthik.sreeni@cub'),
  ('upi_payee_name', 'MyBizCare'),
  ('plan_price_inr', '999')
on conflict (key) do nothing;

-- One row per attempt to pay. The id doubles as the UPI reference (tr/tn), so
-- a credit alert can be matched back to the business that owes it - which is
-- the only handle we have, since a bank VPA reports nothing to us on its own.
--
-- vpa/payee_name/amount_paise are SNAPSHOTS, not lookups: changing the config
-- later must never rewrite the history of what a payer was actually shown.
create table if not exists payment_orders (
  id text primary key,
  mobile text not null,
  -- Null for a signup order until provisioning completes; set from the start
  -- for a renewal, which by definition already has a tenant.
  tenant_id text references tenants(id),
  purpose text not null check (purpose in ('signup', 'renewal')),
  amount_paise integer not null,
  vpa text not null,
  payee_name text not null,
  -- pending   - QR shown, nothing claimed yet
  -- claimed   - payer says they have paid; a PROVISIONAL licence was granted
  -- confirmed - the credit was seen by an admin or the confirm webhook
  -- rejected  - confirmed NOT to have arrived; the licence is expired at once
  -- expired   - the QR window elapsed with no claim
  status text not null check (status in ('pending', 'claimed', 'confirmed', 'rejected', 'expired')),
  utr text,
  claimed_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by text,
  -- What this order actually granted, so the admin queue can show the
  -- consequence of confirming rather than just the fact of it.
  licensed_until timestamptz,
  qr_expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists payment_orders_mobile_idx on payment_orders (mobile, created_at desc);
create index if not exists payment_orders_open_idx on payment_orders (status)
  where status in ('pending', 'claimed');

-- The app connects as the non-owner app_runtime role, so a new table without
-- explicit grants surfaces as a 500. See the same block in schema.sql.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    grant select, insert, update, delete on platform_settings to app_runtime;
    grant select, insert, update, delete on payment_orders    to app_runtime;
  end if;
end $$;
