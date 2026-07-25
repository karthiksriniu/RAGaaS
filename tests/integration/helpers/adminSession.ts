/** Logs into the staging admin API and returns a Cookie header value usable
 * on subsequent requests. */
export async function getAdminSessionCookie(): Promise<string> {
  const baseUrl = requireEnv("TEST_BASE_URL");
  const password = requireEnv("TEST_ADMIN_PASSWORD");

  const res = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    throw new Error(`Admin login failed in test setup: ${res.status} ${await res.text()}`);
  }
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("Admin login succeeded but no session cookie was set");
  // Strip cookie attributes (Path, HttpOnly, etc.) - only the name=value pair
  // is needed for the Cookie request header.
  return setCookie.split(";")[0];
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured (.env.test)`);
  return value;
}
