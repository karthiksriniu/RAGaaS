import { headers } from "next/headers";
import ChatClient from "./ChatClient";
import { getTenant } from "@/lib/tenants";
import { Card } from "@/components/kiowa/Card";
import { Logo } from "@/components/Logo";

// This page's content depends entirely on the request's Host header (which
// tenant, or no tenant at all) - it must never be statically cached or
// served stale across different hosts. headers() alone didn't reliably
// force that in every deployment; this makes it explicit.
export const dynamic = "force-dynamic";

function LandingMessage({ text }: { text: string }) {
  return (
    <div
      className="flex min-h-screen items-center justify-center px-4"
      style={{ background: "var(--color-surface)" }}
    >
      <Card variant="elevated" padding={32} style={{ maxWidth: 420, textAlign: "center" }}>
        <div className="mb-4 flex justify-center">
          <Logo size={40} />
        </div>
        <p className="kw-body-large" style={{ color: "var(--color-on-surface-variant)" }}>
          {text}
        </p>
      </Card>
    </div>
  );
}

function NoTenantLanding() {
  return <LandingMessage text="This address isn't linked to a business yet." />;
}

function TenantExpiredLanding() {
  return <LandingMessage text="This service is currently unavailable — contact the business for details." />;
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
