"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { TextField } from "@/components/kiowa/TextField";
import { StatusPill } from "@/components/kiowa/StatusPill";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";

interface Billing {
  vpa: string;
  payeeName: string;
  priceInr: number;
  amountPaise: number;
}

interface Order {
  id: string;
  mobile: string;
  tenantId: string | null;
  businessName: string | null;
  purpose: "signup" | "renewal";
  amountPaise: number;
  vpa: string;
  status: "pending" | "claimed" | "confirmed" | "rejected" | "expired";
  utr: string | null;
  claimedAt: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  licensedUntil: string | null;
  createdAt: string;
}

const TONES: Record<Order["status"], "neutral" | "primary" | "urgent" | "success" | "info"> = {
  // Claimed is the only one that needs a person: a business is running on a
  // 3-day provisional licence until someone looks at the bank app.
  claimed: "urgent",
  pending: "info",
  confirmed: "success",
  rejected: "neutral",
  expired: "neutral",
};

const LABELS: Record<Order["status"], string> = {
  claimed: "Needs checking",
  pending: "Awaiting payment",
  confirmed: "Confirmed",
  rejected: "Rejected",
  expired: "Expired",
};

function when(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

export default function AdminBilling() {
  const router = useRouter();
  const [billing, setBilling] = useState<Billing | null>(null);
  const [paymentsLive, setPaymentsLive] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  const [vpa, setVpa] = useState("");
  const [payeeName, setPayeeName] = useState("");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingOn, setActingOn] = useState<string | null>(null);

  async function load() {
    const [s, p] = await Promise.all([
      fetch("/api/admin/settings"),
      fetch("/api/admin/payments"),
    ]);
    if (s.status === 401 || p.status === 401) return router.push("/admin/login");
    const settings = await s.json();
    setBilling(settings.billing);
    setPaymentsLive(!!settings.upiPaymentsEnabled);
    setVpa(settings.billing.vpa);
    setPayeeName(settings.billing.payeeName);
    setPrice(String(settings.billing.priceInr));
    setOrders((await p.json()).orders || []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveSettings() {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vpa, payeeName, priceInr: price }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not save");
      setBilling(d.billing);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function act(id: string, action: "confirm" | "reject") {
    setError(null);
    setActingOn(id);
    try {
      const res = await fetch(`/api/admin/payments/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not update that payment");
      setOrders(d.orders || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setActingOn(null);
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
          Billing
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
        {error && (
          <p className="kw-body-small mb-4 rounded-lg p-3" style={{ background: "var(--color-error-container)", color: "var(--color-on-error-container)" }}>
            {error}
          </p>
        )}

        <Card variant="outlined" padding={24}>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="kw-title-medium">Where the money goes</h2>
            <StatusPill
              label={paymentsLive ? "Collecting real payments" : "Payments simulated"}
              tone={paymentsLive ? "success" : "info"}
            />
          </div>
          <p className="kw-body-small mb-5" style={{ color: "var(--color-on-surface-variant)" }}>
            {paymentsLive
              ? "Signups and renewals show a UPI QR for this ID. Every payment lands in the queue below for you to confirm."
              : "This environment settles payments automatically without showing a QR, so signup stays testable. Set UPI_PAYMENTS=on to exercise the real flow here."}
          </p>

          <TextField fullWidth label="UPI ID (VPA)" value={vpa} onChange={(e) => setVpa(e.target.value)} />
          <div className="mt-4">
            <TextField fullWidth label="Payee name shown to the payer" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} />
          </div>
          <div className="mt-4">
            <TextField fullWidth label="Plan price (₹ per month)" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" />
          </div>
          <p className="kw-body-small mt-3" style={{ color: "var(--color-on-surface-variant)" }}>
            Changes apply to new payments only. Anyone currently looking at a QR still pays exactly
            what that QR says — every order keeps its own copy of the UPI ID and amount.
          </p>
          <div className="mt-4">
            <Button variant="filled" size="small" disabled={saving} onClick={saveSettings}>
              {saving ? "Saving…" : saved ? "Saved" : "Save"}
            </Button>
          </div>
        </Card>

        <h2 className="kw-title-medium mt-8 mb-1">Payments</h2>
        <p className="kw-body-medium mb-4" style={{ color: "var(--color-on-surface-variant)" }}>
          &ldquo;Needs checking&rdquo; means a business said it paid and is running on a 3-day
          licence. Check {billing?.vpa} for the reference or UTR, then confirm — that gives them
          the full month, dated from when they paid.
        </p>

        {orders.length === 0 && (
          <p className="kw-body-medium" style={{ color: "var(--color-on-surface-variant)" }}>
            No payments yet.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {orders.map((o) => (
            <Card key={o.id} variant="outlined" padding={16}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="kw-title-medium">{o.businessName || o.mobile}</span>
                    <StatusPill label={LABELS[o.status]} tone={TONES[o.status]} />
                    {o.purpose === "renewal" && <StatusPill label="Renewal" tone="neutral" />}
                  </div>
                  <p className="kw-body-small mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
                    ₹{(o.amountPaise / 100).toFixed(0)} · {o.mobile} · ref <strong>{o.id}</strong>
                    {o.utr ? ` · UTR ${o.utr}` : ""}
                  </p>
                  <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
                    Opened {when(o.createdAt)}
                    {o.claimedAt ? ` · said paid ${when(o.claimedAt)}` : ""}
                    {o.confirmedAt ? ` · settled ${when(o.confirmedAt)}${o.confirmedBy ? ` by ${o.confirmedBy}` : ""}` : ""}
                    {o.licensedUntil ? ` · licensed to ${when(o.licensedUntil)}` : ""}
                  </p>
                </div>
                {(o.status === "claimed" || o.status === "pending") && (
                  <div className="flex gap-2">
                    <Button
                      variant="filled"
                      size="small"
                      icon="check"
                      disabled={actingOn === o.id}
                      onClick={() => act(o.id, "confirm")}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={actingOn === o.id}
                      onClick={() => act(o.id, "reject")}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
