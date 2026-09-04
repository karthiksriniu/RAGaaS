-- 009: Cashfree gateway, standing instructions, and a second plan.
--
-- Replaces "payer scans a QR to a bank VPA and an admin confirms the credit by
-- hand" with "payer authorises a mandate on a gateway and a webhook confirms
-- it". Two things change shape as a result:
--
--  1. An order now belongs to a PLAN (monthly or annual) rather than being the
--     one price there ever was, and to a PROVIDER, because the UPI/VPA path is
--     kept as a fallback rather than deleted.
--  2. Money now arrives on a schedule nobody triggers, so there has to be a
--     record of the standing instruction itself - payment_orders describes one
--     payment, and a mandate outlives any of them.
--
-- Entirely additive and idempotent. Every column has a default matching what
-- the existing rows already mean, so this is safe to apply BEFORE the code that
-- reads it and safe to leave applied if that code is rolled back.

alter table payment_orders
  -- 'monthly' | 'annual'. Existing rows are all the ₹999 month.
  add column if not exists plan text not null default 'monthly',
  -- 'upi' | 'cashfree'. Existing rows all predate the gateway.
  add column if not exists provider text not null default 'upi',
  -- Cashfree's own identifiers. Nullable because a UPI-provider order has
  -- none, and because they arrive at different moments in the flow.
  add column if not exists cf_order_id text,
  add column if not exists cf_subscription_id text,
  add column if not exists cf_payment_session_id text;

-- Not a check constraint on `plan`/`provider`: schema.sql's own convention for
-- payment_orders.status uses one, but that column was born with its full set of
-- values known. These two will gain values (other providers, other plans)
-- and an ALTER of a check constraint on a live table is a worse trade than
-- validating in upi.ts, where isPlan() already has to exist for the API.

-- Looking up the order a webhook is about. Cashfree sends its own ids, never
-- ours, so this is the only way back to a payment_orders row.
create index if not exists payment_orders_cf_order_idx
  on payment_orders (cf_order_id) where cf_order_id is not null;
create index if not exists payment_orders_cf_subscription_idx
  on payment_orders (cf_subscription_id) where cf_subscription_id is not null;

-- The standing instruction itself.
--
-- Named billing_subscriptions, not subscriptions: 008 already put
-- admin_push_subscriptions in this database, and two tables a glance apart
-- meaning "web push registration" and "a mandate that moves money" is the kind
-- of ambiguity that eventually gets read the wrong way round.
create table if not exists billing_subscriptions (
  id text primary key,
  -- Null until signup provisions the tenant, exactly like payment_orders:
  -- the mandate is authorised before the business exists.
  tenant_id text references tenants(id),
  mobile text not null,
  plan text not null,
  cf_subscription_id text unique not null,
  -- pending | active | on_hold | cancelled | completed
  status text not null,
  amount_paise int not null,
  next_charge_at timestamptz,
  last_charge_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_subscriptions_tenant_idx
  on billing_subscriptions (tenant_id) where tenant_id is not null;
create index if not exists billing_subscriptions_mobile_idx
  on billing_subscriptions (mobile, created_at desc);

-- The idempotency ledger, and the reason a retried webhook cannot extend a
-- licence twice.
--
-- Cashfree retries a webhook it did not get a 2xx for, and a mandate debit that
-- was delivered twice would otherwise read as two months paid for. The insert
-- of the provider's event id is the gate: it succeeds exactly once, and the
-- handler runs only for the insert that won.
--
-- payload is kept because a webhook is the only record of a charge we did not
-- initiate - if a licence is ever wrong, this is what says why.
create table if not exists webhook_events (
  id text primary key,
  provider text not null,
  type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);

create index if not exists webhook_events_received_idx
  on webhook_events (received_at desc);

-- The annual plan's price, alongside plan_price_inr from 005. Seeded, not
-- hardcoded, for the same reason the monthly one is: the marketing page reads
-- its price from here, so the page cannot drift from what is actually charged.
insert into platform_settings (key, value)
values ('plan_price_annual_inr', '9999')
on conflict (key) do nothing;

-- The app connects as the non-owner app_runtime role, so a new table without
-- explicit grants surfaces as a 500. See the same block in schema.sql.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    grant select, insert, update, delete on billing_subscriptions to app_runtime;
    grant select, insert, update, delete on webhook_events        to app_runtime;
  end if;
end $$;
