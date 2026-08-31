-- 008: browser push subscriptions for the admin payments queue.
--
-- A claimed order is the one payment state that needs a human: the business is
-- already running on a 3-day provisional licence and stops answering calls if
-- nobody checks the bank app in time. The queue at /admin/billing has always
-- shown it, but only to somebody who happened to be looking at the page.
--
-- One row per browser, not per admin. The Web Push endpoint IS the identity -
-- there is no per-user admin login to key this on (adminAuth is a single shared
-- password), and the same person legitimately subscribes from a phone and a
-- laptop and expects both to buzz.
--
-- Not RLS-scoped, for the same reason platform_settings isn't: this is platform
-- operations, not tenant content.
--
-- Reversible: drop the table. The app treats "no subscriptions" and "no VAPID
-- keys configured" identically - it simply sends nothing.
create table if not exists admin_push_subscriptions (
  -- The push service's URL for this browser. Long, opaque, and unique per
  -- browser install; re-subscribing after a permission reset produces a new
  -- one, which is why upserting on it is correct rather than deduplicating on
  -- anything else.
  endpoint text primary key,
  -- The two halves of the ECDH keypair the browser gave us. Without both, a
  -- payload cannot be encrypted and the push is rejected.
  p256dh text not null,
  auth text not null,
  -- Purely so a person can tell "my phone" from "my laptop" when pruning.
  user_agent text,
  created_at timestamptz not null default now(),
  -- Stamped on every accepted send. A subscription that has not succeeded in a
  -- long time is a candidate for removal, though the push service telling us
  -- 404/410 is the authoritative signal and the app prunes on that.
  last_success_at timestamptz
);

-- The app connects as the non-owner app_runtime role, so a new table without
-- explicit grants surfaces as a 500. See the same block in schema.sql.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    grant select, insert, update, delete on admin_push_subscriptions to app_runtime;
  end if;
end $$;
