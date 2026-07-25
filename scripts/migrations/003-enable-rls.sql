-- Run only after the non-owner app_runtime role exists on this environment
-- and has been verified (see the Phase 2 plan's role-verification steps).
-- Fail-closed by construction: current_setting(..., true) returns NULL
-- instead of erroring when app.tenant_id was never set for the transaction,
-- and tenant_id = NULL is never true - a code path that forgets to set the
-- session variable gets zero rows back, not another tenant's data.
--
-- Rollback is one line: alter table chunks disable row level security;
alter table chunks enable row level security;

drop policy if exists tenant_isolation on chunks;
create policy tenant_isolation on chunks
  using (tenant_id = current_setting('app.tenant_id', true))
  with check (tenant_id = current_setting('app.tenant_id', true));
