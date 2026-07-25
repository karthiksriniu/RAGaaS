import { getAdminSessionCookie, requireEnv } from "./adminSession";
import { getTestDbClient } from "./db";

export const TEST_TENANT_PREFIX = "test-";

export function uniqueTestTenantId(label: string): string {
  return `${TEST_TENANT_PREFIX}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

interface CreateTestTenantOptions {
  name?: string;
  licenseExpiresAt?: string | null;
  whatsappNumber?: string | null;
}

/** Creates a tenant via the real admin API (not direct SQL) so tests exercise
 * the actual validation/creation path, not a shortcut around it. */
export async function createTestTenant(
  idSuffix: string,
  options: CreateTestTenantOptions = {}
): Promise<{ id: string; subdomain: string; cookie: string }> {
  const baseUrl = requireEnv("TEST_BASE_URL");
  const cookie = await getAdminSessionCookie();
  const id = uniqueTestTenantId(idSuffix);

  const res = await fetch(`${baseUrl}/api/admin/tenants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name: options.name || `Test Tenant ${idSuffix}`,
      subdomain: id,
      licenseExpiresAt: options.licenseExpiresAt ?? null,
      whatsappNumber: options.whatsappNumber ?? null,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to create test tenant: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return { id: data.tenant.id, subdomain: data.tenant.subdomain, cookie };
}

/** Deletes every test-prefixed tenant (and its chunks) from the STAGING
 * database. Guarded against running on production - see helpers/db.ts. */
export async function cleanupTestTenants(): Promise<void> {
  const client = getTestDbClient();
  await client.connect();
  try {
    await client.query(`DELETE FROM chunks WHERE tenant_id LIKE $1`, [`${TEST_TENANT_PREFIX}%`]);
    const result = await client.query(`DELETE FROM tenants WHERE id LIKE $1 RETURNING id`, [
      `${TEST_TENANT_PREFIX}%`,
    ]);
    if (result.rows.length > 0) {
      console.log(`Cleaned up ${result.rows.length} test tenant(s): ${result.rows.map((r) => r.id).join(", ")}`);
    }
  } finally {
    await client.end();
  }
}
