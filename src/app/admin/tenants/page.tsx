"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/kiowa/Button";
import { TextField } from "@/components/kiowa/TextField";
import { Textarea } from "@/components/kiowa/Textarea";
import { Card } from "@/components/kiowa/Card";
import { StatusPill } from "@/components/kiowa/StatusPill";
import { Logo } from "@/components/Logo";

interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  twilioWhatsappNumber: string | null;
  twilioAccountSid: string | null;
  hasCustomTwilioAuthToken: boolean;
  answerConfigMd: string | null;
  licenseExpiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

const E164 = /^\+[1-9]\d{7,14}$/;

// The standing UAT/QA tenant the demo web chat and default WhatsApp number
// fall back to - its license can't be set to expire (guarded server-side
// too, in src/lib/tenants.ts), and it's called out distinctly here rather
// than shown as just another "active" tenant.
const PROTECTED_TENANT_ID = "default";

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
  const [twilioAccountSid, setTwilioAccountSid] = useState("");
  const [twilioAuthToken, setTwilioAuthToken] = useState("");
  const [answerConfigMd, setAnswerConfigMd] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingLicenseId, setEditingLicenseId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState("");
  const [editingNumberId, setEditingNumberId] = useState<string | null>(null);
  const [editNumber, setEditNumber] = useState("");
  const [editNumberError, setEditNumberError] = useState<string | null>(null);
  const [editingTwilioId, setEditingTwilioId] = useState<string | null>(null);
  const [editTwilioSid, setEditTwilioSid] = useState("");
  const [editTwilioToken, setEditTwilioToken] = useState("");
  const [editTwilioError, setEditTwilioError] = useState<string | null>(null);
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [editConfigMd, setEditConfigMd] = useState("");
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
          twilioAccountSid: twilioAccountSid.trim() || null,
          twilioAuthToken: twilioAuthToken.trim() || null,
          answerConfigMd: answerConfigMd.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create tenant");
      setName("");
      setSubdomain("");
      setLicenseExpiresAt("");
      setWhatsappNumber("");
      setTwilioAccountSid("");
      setTwilioAuthToken("");
      setAnswerConfigMd("");
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

  function startEditTwilio(tenant: Tenant) {
    setEditingTwilioId(tenant.id);
    // Never pre-filled with the real values - the API never returns the
    // auth token, and re-showing the account SID here would invite
    // accidentally saving a stale/half-edited pair. Blank fields with
    // "Save" meaning "replace with these" is the accurate model.
    setEditTwilioSid("");
    setEditTwilioToken("");
    setEditTwilioError(null);
  }

  async function saveEditTwilio(id: string) {
    const sid = editTwilioSid.trim();
    const token = editTwilioToken.trim();
    if ((sid && !token) || (!sid && token)) {
      setEditTwilioError("Provide both the Account SID and Auth Token together, or leave both blank to clear");
      return;
    }
    const res = await fetch(`/api/admin/tenants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ twilioAccountSid: sid || null, twilioAuthToken: token || null }),
    });
    const data = await res.json();
    if (!res.ok) {
      setEditTwilioError(data.error || "Could not save");
      return;
    }
    setEditingTwilioId(null);
    await refresh();
  }

  function startEditConfig(tenant: Tenant) {
    setEditingConfigId(tenant.id);
    setEditConfigMd(tenant.answerConfigMd || "");
  }

  async function saveEditConfig(id: string) {
    await fetch(`/api/admin/tenants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answerConfigMd: editConfigMd.trim() || null }),
    });
    setEditingConfigId(null);
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
        <div className="flex gap-2">
          <Link href="/admin/billing">
            <Button type="button" variant="text" icon="payments">Billing</Button>
          </Link>
          <Link href="/admin">
            <Button type="button" variant="text" icon="description">Knowledge sources</Button>
          </Link>
        </div>
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
            <TextField
              label="Twilio Account SID (optional - only if this tenant has its own subaccount)"
              placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              value={twilioAccountSid}
              onChange={(e) => setTwilioAccountSid(e.target.value)}
              style={{ width: "100%" }}
            />
            <TextField
              label="Twilio Auth Token (required together with the Account SID above)"
              type="password"
              value={twilioAuthToken}
              onChange={(e) => setTwilioAuthToken(e.target.value)}
              style={{ width: "100%" }}
            />
            <Textarea
              label="Answer style & KB guidance (optional, can be added later)"
              placeholder="How should this business's answers read? e.g. crisp and single-topic vs. conversational, summary-first vs. detailed-first, how to weigh this KB's content..."
              rows={6}
              value={answerConfigMd}
              onChange={(e) => setAnswerConfigMd(e.target.value)}
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
          {[...tenants]
            .sort((a, b) => (a.id === PROTECTED_TENANT_ID ? -1 : b.id === PROTECTED_TENANT_ID ? 1 : 0))
            .map((t) => {
            const isProtected = t.id === PROTECTED_TENANT_ID;
            const expired = isExpired(t);
            const url = rootDomain ? `https://${t.subdomain}.${rootDomain}` : null;
            return (
              <Card key={t.id} variant="outlined" padding={16}>
                <div className="flex items-center gap-2">
                  <span className="kw-title-small" style={{ color: "var(--color-on-surface)" }}>{t.name}</span>
                  {isProtected ? (
                    <StatusPill label="default" tone="primary" />
                  ) : (
                    <StatusPill label={expired ? "expired" : "active"} tone={expired ? "urgent" : "success"} />
                  )}
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

                {isProtected ? (
                  <div className="mt-3 flex items-center gap-3">
                    <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                      No expiry — protected from ever being set
                    </span>
                  </div>
                ) : editingLicenseId === t.id ? (
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

                {editingTwilioId === t.id ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <TextField
                        label="Account SID"
                        placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                        value={editTwilioSid}
                        onChange={(e) => setEditTwilioSid(e.target.value)}
                        error={!!editTwilioError}
                        style={{ minWidth: 240 }}
                      />
                      <TextField
                        label="Auth Token"
                        type="password"
                        value={editTwilioToken}
                        onChange={(e) => setEditTwilioToken(e.target.value)}
                        error={!!editTwilioError}
                        style={{ minWidth: 200 }}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="filled" size="small" onClick={() => saveEditTwilio(t.id)}>Save</Button>
                      <Button type="button" variant="text" size="small" onClick={() => setEditingTwilioId(null)}>Cancel</Button>
                    </div>
                    <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                      Leave both blank and save to revert to the platform's default Twilio account.
                    </p>
                    {editTwilioError && (
                      <p className="kw-body-small" style={{ color: "var(--color-error)" }}>
                        {editTwilioError}
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-3">
                    <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                      {t.hasCustomTwilioAuthToken
                        ? `Own Twilio subaccount: ${t.twilioAccountSid}`
                        : "Using the platform's default Twilio account"}
                    </span>
                    <Button type="button" variant="text" size="small" onClick={() => startEditTwilio(t)}>Edit</Button>
                  </div>
                )}

                {editingConfigId === t.id ? (
                  <div className="mt-2 flex flex-col gap-2">
                    <Textarea
                      rows={8}
                      placeholder="How should this business's answers read? e.g. crisp and single-topic vs. conversational, summary-first vs. detailed-first, how to weigh this KB's content..."
                      value={editConfigMd}
                      onChange={(e) => setEditConfigMd(e.target.value)}
                    />
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="filled" size="small" onClick={() => saveEditConfig(t.id)}>Save</Button>
                      <Button type="button" variant="text" size="small" onClick={() => setEditingConfigId(null)}>Cancel</Button>
                    </div>
                    <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                      Leave blank and save to revert to the platform's default answer tone.
                    </p>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-3">
                    <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                      {t.answerConfigMd
                        ? `Answer style configured (${t.answerConfigMd.length} chars)`
                        : "Answer style: using the platform's default tone"}
                    </span>
                    <Button type="button" variant="text" size="small" onClick={() => startEditConfig(t)}>Edit</Button>
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
