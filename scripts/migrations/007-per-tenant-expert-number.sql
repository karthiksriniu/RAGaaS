-- 007: the human a call is handed to is per tenant, not per deployment.
--
-- EXPERT_PHONE_NUMBER was a single environment variable read in three places -
-- the worker's warm transfer, /api/escalate and the WhatsApp webhook - so every
-- tenant's "put me through to a person" rang the SAME phone. On a single-tenant
-- pilot that was invisible. With self-service signup it means one business's
-- customer is transferred to a different business's owner, which is a privacy
-- problem as much as a product one.
--
-- The column is nullable and the app still falls back to the environment
-- variable when it is null, so this migration is safe to apply before the code
-- that reads it, and safe to leave applied if that code is rolled back.
alter table tenants add column if not exists expert_phone_number text;

-- Seed every existing tenant with the mobile its owner signed up on. That
-- number is already OTP-verified (it is how they log in), so this hands every
-- business a working transfer target without asking anyone to re-verify
-- anything - and it is the number they would almost certainly have chosen.
--
-- Only where null, so re-running this migration cannot overwrite a number a
-- business has since set for itself.
update tenants t
   set expert_phone_number = a.mobile
  from business_accounts a
 where a.tenant_id = t.id
   and t.expert_phone_number is null
   and a.mobile is not null;
