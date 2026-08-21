"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { TextField } from "@/components/kiowa/TextField";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";

interface PooledNumber {
  e164: string;
  tenantId: string | null;
  businessName: string | null;
  claimedAt: string | null;
}

interface Tenant {
  id: string;
  name: string;
}

export default function AdminNumbersPage() {
  const [numbers, setNumbers] = useState<PooledNumber[]>([]);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newNumber, setNewNumber] = useState("");

  async function load() {
    const [n, t] = await Promise.all([
      fetch("/api/admin/numbers").then((r) => (r.ok ? r.json() : { numbers: [] })),
      fetch("/api/admin/tenants").then((r) => (r.ok ? r.json() : { tenants: [] })),
    ]);
    setNumbers(n.numbers || []);
    setTenants((t.tenants || []).filter((x: Tenant & { archivedAt?: string | null }) => !x.archivedAt));
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "That didn't work");
      if (d.numbers) setNumbers(d.numbers);
      // Reassignment takes a working line away from someone. Say so plainly
      // rather than letting the admin find out when that business calls.
      if (d.previousTenantId) {
        setNotice(`Taken from "${d.previousTenantId}" — that business no longer has a number.`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center" style={{ background: "var(--color-surface)" }}>
        <ProgressIndicator variant="circular" size={32} />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--color-surface)", color: "var(--color-on-surface)" }}>
      <header
        className="flex items-center justify-between px-6 py-4"
        style={{ borderBottom: "1px solid var(--color-outline-variant)" }}
      >
        <h1
          className="kw-title-large"
          style={{ fontFamily: "var(--font-brand)", fontWeight: "var(--weight-bold)", color: "var(--color-primary)" }}
        >
          Phone numbers
        </h1>
        <div className="flex gap-2">
          <Link href="/admin/tenants">
            <Button type="button" variant="text" icon="group">Tenants</Button>
          </Link>
          <Link href="/admin">
            <Button type="button" variant="text" icon="arrow_back">Admin</Button>
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <p className="kw-body-medium mb-6" style={{ color: "var(--color-on-surface-variant)" }}>
          Point a number at whichever business you&apos;re demonstrating. Assigning a number that
          another business holds takes it from them immediately — their callers will reach the new
          business instead.
        </p>

        {error && (
          <p className="kw-body-small mb-4 rounded-lg p-3" style={{ background: "var(--color-error-container)", color: "var(--color-on-error-container)" }}>
            {error}
          </p>
        )}
        {notice && (
          <p className="kw-body-small mb-4 rounded-lg p-3" style={{ background: "var(--color-tertiary-container)", color: "var(--color-on-tertiary-container)" }}>
            {notice}
          </p>
        )}

        <div className="flex flex-col gap-4">
          {numbers.map((n) => (
            <Card key={n.e164} variant="outlined" padding={20}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="kw-title-medium">{n.e164}</span>
                <span className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                  {n.tenantId ? `held by ${n.businessName ?? n.tenantId}` : "free"}
                </span>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <select
                  aria-label={`Assign ${n.e164} to a business`}
                  value={n.tenantId ?? ""}
                  disabled={busy === n.e164}
                  onChange={(e) => {
                    const tenantId = e.target.value;
                    post(tenantId ? { e164: n.e164, tenantId } : { e164: n.e164, action: "release" }, n.e164);
                  }}
                  className="rounded-lg px-3 py-2"
                  style={{
                    border: "1px solid var(--color-outline-variant)",
                    background: "var(--color-surface)",
                    color: "var(--color-on-surface)",
                    fontFamily: "var(--font-ui)",
                    fontSize: 14,
                    minWidth: 220,
                  }}
                >
                  <option value="">— not assigned —</option>
                  {tenants.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.id})
                    </option>
                  ))}
                </select>
                {busy === n.e164 && <ProgressIndicator variant="circular" size={16} thickness={2} />}
                {n.tenantId && busy !== n.e164 && (
                  <Button
                    variant="text"
                    size="small"
                    icon="link_off"
                    onClick={() => post({ e164: n.e164, action: "release" }, n.e164)}
                  >
                    Release
                  </Button>
                )}
              </div>
            </Card>
          ))}

          {numbers.length === 0 && (
            <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
              No numbers in the pool yet.
            </p>
          )}
        </div>

        <Card variant="outlined" padding={20} className="mt-8">
          <p className="kw-title-small mb-1">Add a number</p>
          <p className="kw-body-small mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
            Only records a number you have already bought in Vobiz and pointed at the LiveKit trunk.
            This does not purchase anything.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <TextField
              fullWidth={false}
              label="Number"
              value={newNumber}
              onChange={(e) => setNewNumber(e.target.value)}
              placeholder="+918071580725"
            />
            <Button
              variant="filled"
              size="small"
              disabled={busy === "add"}
              onClick={async () => {
                await post({ e164: newNumber.trim(), action: "add" }, "add");
                setNewNumber("");
              }}
            >
              Add to pool
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
