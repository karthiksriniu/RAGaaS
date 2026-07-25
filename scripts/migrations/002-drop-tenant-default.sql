-- Run only after the mandatory-tenantId app code (Phase 2) is deployed to
-- this environment. Before that, the app still relies on this column
-- default to silently fill in 'default' for the old single-tenant code
-- paths - dropping it early would break the still-deployed old code.
alter table chunks alter column tenant_id drop default;
