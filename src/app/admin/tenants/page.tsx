"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface Tenant {
  id: string;
  name: string;
  subdomain: string;
  twilioWhatsappNumber: string | null;
  licenseExpiresAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

function isExpired(tenant: Tenant): boolean {
  return !!tenant.licenseExpiresAt && new Date(tenant.licenseExpiresAt) <= new Date();
}

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

export default function AdminTenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [rootDomain, setRootDomain] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [licenseExpiresAt, setLicenseExpiresAt] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState("");
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
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not create tenant");
      setName("");
      setSubdomain("");
      setLicenseExpiresAt("");
      await refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  function startEdit(tenant: Tenant) {
    setEditingId(tenant.id);
    setEditDate(toDateInputValue(tenant.licenseExpiresAt));
  }

  async function saveEdit(id: string) {
    await fetch(`/api/admin/tenants/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseExpiresAt: editDate || null }),
    });
    setEditingId(null);
    await refresh();
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-green-800">AgriAdvisor admin</h1>
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-500">
            Tenants
          </span>
        </div>
        <Link href="/admin" className="text-sm text-neutral-500 hover:text-neutral-800">
          Knowledge sources
        </Link>
      </header>

      <div className="mx-auto max-w-2xl px-6 py-8">
        <h2 className="mb-3 text-sm font-medium text-neutral-700">Create a tenant</h2>
        <form
          onSubmit={handleCreate}
          className="mb-8 flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-4"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Business name"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          />
          <input
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value)}
            placeholder="Subdomain (e.g. hospitalinsuranceco)"
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          />
          <label className="text-xs text-neutral-500">License expiry (optional, blank = no expiry)</label>
          <input
            type="date"
            value={licenseExpiresAt}
            onChange={(e) => setLicenseExpiresAt(e.target.value)}
            className="rounded-lg border border-neutral-300 px-3 py-2 text-sm"
          />
          {createError && <p className="text-xs text-red-600">{createError}</p>}
          <button
            type="submit"
            disabled={creating || !name.trim() || !subdomain.trim()}
            className="mt-1 rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {creating ? "Creating…" : "Create tenant"}
          </button>
        </form>

        <h2 className="mb-3 text-sm font-medium text-neutral-700">Tenants</h2>
        <ul className="flex flex-col gap-2">
          {tenants.map((t) => {
            const expired = isExpired(t);
            const url = rootDomain ? `https://${t.subdomain}.${rootDomain}` : null;
            return (
              <li key={t.id} className="rounded-lg border border-neutral-200 bg-white p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{t.name}</span>{" "}
                    <span
                      className={`ml-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                        expired
                          ? "bg-red-100 text-red-700"
                          : "bg-green-100 text-green-800"
                      }`}
                    >
                      {expired ? "expired" : "active"}
                    </span>
                  </div>
                </div>
                {url && (
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-neutral-500 hover:underline"
                  >
                    {url}
                  </a>
                )}

                {editingId === t.id ? (
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="rounded-lg border border-neutral-300 px-2 py-1 text-xs"
                    />
                    <button
                      onClick={() => saveEdit(t.id)}
                      className="rounded-lg bg-green-700 px-3 py-1 text-xs font-medium text-white"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-xs text-neutral-500"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
                    <span>
                      {t.licenseExpiresAt
                        ? `Expires ${new Date(t.licenseExpiresAt).toLocaleDateString()}`
                        : "No expiry"}
                    </span>
                    <button onClick={() => startEdit(t)} className="text-green-700 hover:underline">
                      Edit
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
