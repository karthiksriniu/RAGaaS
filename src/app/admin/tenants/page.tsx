"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/kiowa/Button";
import { TextField } from "@/components/kiowa/TextField";
import { Card } from "@/components/kiowa/Card";
import { StatusPill } from "@/components/kiowa/StatusPill";
import { Logo } from "@/components/Logo";

interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  twilioWhatsappNumber: string | null;
  licenseExpiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

const E164 = /^\+[1-9]\d{7,14}$/;

function isExpired(tenant: Tenant): boolean {
  return !!tenant.licenseExpiresAt && new Date(tenant.licenseExpiresAt) <= new Date();
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

// Stored/compared in Twilio's wire format ("whatsapp:+1..."); shown to the
// admin as a plain E.164 number, consistent with every other phone input.
function stripWhatsappPrefix(value: string | null): string {
  if (!value) return "";
  return value.replace(/^whatsapp:/, "");
}

export default function AdminTenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [rootDomain, setRootDomain] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [licenseExpiresAt, setLicenseExpiresAt] = useState("");
  const [whatsappNumber, setWhatsappNumber] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingLicenseId, setEditingLicenseId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editingNumberId, setEditingNumberId] = useState<string | null>(null);
  const [editNumber, setEditNumber] = useState("");
  const [editNumberError, setEditNumberError] = useState<string | null>(null);
  const router = useRouter();

  async function refresh() {
    const res = await fetch("/api/admin/tenants");
    if (res.status === 401) {
      router.push("/admin/login");
      return;
    }
    const data = await res.json();
    setTenants(data.tenants || []);
    setRootDomain(data.rootDomain || null);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/admin/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          subdomain: subdomain.trim(),
          licenseExpiresAt: licenseExpiresAt || null,
          whatsappNumber: whatsappNumber.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create tenant");
      setName("");
      setSubdomain("");
      setLicenseExpiresAt("");
      setWhatsappNumber("");
      await refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function startEditLicense(tenant: Tenant) {
    setEditingLicenseId(tenant.id);
    setEditDate(toDateInputValue(tenant.licenseExpiresAt));
  }

  async function saveEditLicense(id: string) {
    await fetch(`/api/admin/tenants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseExpiresAt: editDate || null }),
    });
    setEditingLicenseId(null);
    await refresh();
  }

  function startEditNumber(tenant: Tenant) {
    setEditingNumberId(tenant.id);
    setEditNumber(stripWhatsappPrefix(tenant.twilioWhatsappNumber));
    setEditNumberError(null);
  }

  async function saveEditNumber(id: string) {
    const trimmed = editNumber.trim();
    if (trimmed && !E164.test(trimmed)) {
      setEditNumberError("Use international format, e.g. +14155238886");
      return;
    }
    const res = await fetch(`/api/admin/tenants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ whatsappNumber: trimmed || null }),
    });
    const data = await res.json();
    if (!res.ok) {
      setEditNumberError(data.error || "Could not save");
      return;
    }
    setEditingNumberId(null);
    await refresh();
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--color-surface)", color: "var(--color-on-surface)" }}>
      <header
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid var(--color-outline-variant)", background: "var(--color-surface-container-lowest)" }}
      >
        <div className="flex items-center gap-2.5">
          <Logo size={28} />
          <h1 className="kw-title-large" style={{ fontFamily: "var(--font-brand)", fontWeight: "var(--weight-bold)", color: "var(--color-primary)" }}>
            MyBizCare admin
          </h1>
          <StatusPill label="Tenants" tone="neutral" />
        </div>
        <Link href="/admin">
          <Button type="button" variant="text" icon="description">Knowledge sources</Button>
        </Link>
      </header>

      <div className="mx-auto max-w-2xl px-6 py-8">
        <h2 className="kw-label-large mb-3" style={{ color: "var(--color-on-surface-variant)" }}>
          Create a tenant
        </h2>
        <Card variant="outlined" padding={20} style={{ marginBottom: 32 }}>
          <form onSubmit={handleCreate} className="flex flex-col gap-4">
            <TextField
              label="Business name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: "100%" }}
            />
            <TextField
              label="Subdomain"
              placeholder="e.g. hospitalinsuranceco"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              style={{ width: "100%" }}
            />
            <TextField
              label="License expiry (optional, blank = no expiry)"
              type="date"
              value={licenseExpiresAt}
              onChange={(e) => setLicenseExpiresAt(e.target.value)}
              style={{ width: "100%" }}
            />
            <TextField
              label="WhatsApp number (optional, can be added later)"
              placeholder="+14155238886"
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(e.target.value)}
              style={{ width: "100%" }}
            />
            {createError && (
              <p className="kw-body-small" style={{ color: "var(--color-error)" }}>
                {createError}
              </p>
            )}
            <Button type="submit" variant="filled" disabled={creating || !name.trim() || !subdomain.trim()}>
              {creating ? "Creating…" : "Create tenant"}
            </Button>
          </form>
        </Card>

        <h2 className="kw-label-large mb-3" style={{ color: "var(--color-on-surface-variant)" }}>
          Tenants
        </h2>
        <div className="flex flex-col gap-3">
          {tenants.map((t) => {
            const expired = isExpired(t);
            const url = rootDomain ? `https://${t.subdomain}.${rootDomain}` : null;
            return (
              <Card key={t.id} variant="outlined" padding={16}>
                <div className="flex items-center gap-2">
                  <span className="kw-title-small" style={{ color: "var(--color-on-surface)" }}>{t.name}</span>
                  <StatusPill label={expired ? "expired" : "active"} tone={expired ? "urgent" : "success"} />
                </div>
                {url && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="kw-body-small mt-1 inline-block hover:underline"
                    style={{ color: "var(--color-on-surface-variant)" }}
                  >
                    {url}
                  </a>
                )}

                {editingLicenseId === t.id ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <TextField type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} style={{ minWidth: 180 }} />
                    <Button type="button" variant="filled" size="small" onClick={() => saveEditLicense(t.id)}>Save</Button>
                    <Button type="button" variant="text" size="small" onClick={() => setEditingLicenseId(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="mt-3 flex items-center gap-3">
                    <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                      {t.licenseExpiresAt ? `Expires ${new Date(t.licenseExpiresAt).toLocaleDateString()}` : "No expiry"}
                    </span>
                    <Button type="button" variant="text" size="small" onClick={() => startEditLicense(t)}>Edit</Button>
                  </div>
                )}

                {editingNumberId === t.id ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <TextField
                        placeholder="+14155238886"
                        value={editNumber}
                        onChange={(e) => setEditNumber(e.target.value)}
                        error={!!editNumberError}
                        style={{ minWidth: 200 }}
                      />
                      <Button type="button" variant="filled" size="small" onClick={() => saveEditNumber(t.id)}>Save</Button>
                      <Button type="button" variant="text" size="small" onClick={() => setEditingNumberId(null)}>Cancel</Button>
                    </div>
                    {editNumberError && (
                      <p className="kw-body-small" style={{ color: "var(--color-error)" }}>
                        {editNumberError}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-3">
                    <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                      {t.twilioWhatsappNumber ? `WhatsApp: ${stripWhatsappPrefix(t.twilioWhatsappNumber)}` : "No WhatsApp number assigned"}
                    </span>
                    <Button type="button" variant="text" size="small" onClick={() => startEditNumber(t)}>Edit</Button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
