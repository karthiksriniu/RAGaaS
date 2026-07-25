import { cleanupTestTenants } from "./helpers/testTenant";

export async function setup() {
  // Clear any leftover test tenants from a prior interrupted run before
  // starting, so tests never see stale fixtures from a previous attempt.
  await cleanupTestTenants();
}

export async function teardown() {
  await cleanupTestTenants();
}
