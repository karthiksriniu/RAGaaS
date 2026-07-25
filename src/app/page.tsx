import { headers } from "next/headers";
import ChatClient from "./ChatClient";
import { getTenant } from "@/lib/tenants";

function NoTenantLanding() {
  return (
    <div className="flex h-screen items-center justify-center bg-neutral-50 px-4 text-center">
      <p className="text-neutral-500">This address isn&apos;t linked to a business yet.</p>
    </div>
  );
}

function TenantExpiredLanding() {
  return (
    <div className="flex h-screen items-center justify-center bg-neutral-50 px-4 text-center">
      <p className="text-neutral-500">
        This service is currently unavailable — contact the business for details.
      </p>
    </div>
  );
}

export default async function Home() {
  const tenantSlug = (await headers()).get("x-tenant-slug") || "";
  if (!tenantSlug) return <NoTenantLanding />;

  const tenant = await getTenant(tenantSlug);
  if (!tenant) return <NoTenantLanding />;

  if (tenant.licenseExpiresAt && new Date(tenant.licenseExpiresAt) <= new Date()) {
    return <TenantExpiredLanding />;
  }

  return <ChatClient tenantSlug={tenantSlug} />;
}
