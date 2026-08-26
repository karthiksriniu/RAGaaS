"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { TextField } from "@/components/kiowa/TextField";
import { ProgressIndicator } from "@/components/kiowa/ProgressIndicator";

/** What the plan includes. One list, shown at signup and again at renewal, so
 * the two screens can never drift into describing different products. */
export const PLAN_FEATURES = [
  "Your own phone number",
  "AI agent trained on your documents",
  "Unlimited knowledge sources",
  "Handover to your team",
];

export interface PaymentInstructions {
  mode: "upi";
  orderId: string;
  vpa: string;
  payeeName: string;
  amountPaise: number;
  upiUri: string;
  qrDataUrl: string;
  qrExpiresAt: string;
  status: string;
}

interface Props {
  payment: PaymentInstructions;
  /** Called once the payment is good enough to proceed on - either the payer
   * said they paid, or the credit was confirmed while they watched. */
  onSettled: (orderId: string) => void;
  onCancel: () => void;
  error?: string | null;
}

/** The UPI payment screen: a QR for ₹999 payable straight to the platform's
 * own VPA, and a poll that watches for the credit being confirmed.
 *
 * A bank VPA reports nothing back to us, so "waiting for confirmation" can take
 * up to three days - far longer than anyone will sit on a screen. The poll is
 * therefore a fast path, not the mechanism: it catches the case where someone
 * confirms while the payer is still here. The button below is the normal path,
 * and it is what the whole flow is designed around - the payer says they have
 * paid, gets in immediately on a short provisional licence, and the confirmation
 * catches up afterwards. */
export function UpiPayment({ payment, onSettled, onCancel, error }: Props) {
  const [utr, setUtr] = useState("");
  const [busy, setBusy] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const settled = useRef(false);

  const rupees = (payment.amountPaise / 100).toFixed(payment.amountPaise % 100 === 0 ? 0 : 2);

  function settle(orderId: string) {
    if (settled.current) return;
    settled.current = true;
    onSettled(orderId);
  }

  // Polls only while this screen is mounted and unsettled, and stops the moment
  // either happens - no standing timer behind a screen nobody is looking at.
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/business/payment/${payment.orderId}`);
        if (!res.ok) return;
        const d = await res.json();
        if (d.status === "confirmed" || d.status === "claimed") return settle(payment.orderId);
        if (d.status === "expired") setExpired(true);
      } catch {
        // A dropped poll is not worth showing anyone - the next one is 4s away,
        // and the button below works regardless.
      }
    }, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment.orderId]);

  // The QR is only good for its window. Watched locally as well as by the
  // poller so the screen says so even if the network is down.
  useEffect(() => {
    const check = () => setExpired(new Date(payment.qrExpiresAt) <= new Date());
    check();
    const timer = setInterval(check, 10000);
    return () => clearInterval(timer);
  }, [payment.qrExpiresAt]);

  async function claim() {
    setClaimError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/business/payment/${payment.orderId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ utr: utr.trim() || undefined }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Could not record that payment");
      settle(payment.orderId);
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="kw-headline-small mb-1">Pay ₹{rupees}</h1>
      <p className="kw-body-medium mb-5" style={{ color: "var(--color-on-surface-variant)" }}>
        Scan with any UPI app — GPay, PhonePe, Paytm, your bank&apos;s app.
      </p>

      <Card variant="filled" padding={20} style={{ textAlign: "center" }}>
        <div className="flex justify-center">
          <Image
            src={payment.qrDataUrl}
            alt={`UPI QR code to pay ₹${rupees} to ${payment.vpa}`}
            width={220}
            height={220}
            unoptimized
            style={{ borderRadius: "var(--radius-sm)", background: "#fff", padding: 8 }}
          />
        </div>
        <p className="kw-body-small mt-3" style={{ color: "var(--color-on-surface-variant)" }}>
          Paying <strong>{payment.payeeName}</strong>
        </p>
        <p className="kw-body-medium" style={{ fontFamily: "var(--font-mono, monospace)" }}>{payment.vpa}</p>
        <p className="kw-body-small mt-2" style={{ color: "var(--color-on-surface-variant)" }}>
          Reference <strong>{payment.orderId}</strong> — leave this in the payment note so we can
          match your payment.
        </p>
      </Card>

      {/* Only useful on the phone itself, where it opens the UPI app directly
          with the amount already filled in. Harmless on desktop, where the QR
          above is the path. */}
      <a href={payment.upiUri} className="mt-4 block sm:hidden">
        <Button variant="tonal" fullWidth icon="smartphone">Open a UPI app on this phone</Button>
      </a>

      {expired ? (
        <div className="mt-5">
          <p className="kw-body-small mb-3" style={{ color: "var(--color-error)" }}>
            This QR has expired. Start again to get a fresh one — you haven&apos;t been charged.
          </p>
          <Button variant="filled" fullWidth onClick={onCancel}>Get a new QR</Button>
        </div>
      ) : (
        <>
          <div className="mt-5">
            <TextField
              fullWidth
              label="UPI reference / UTR (optional)"
              value={utr}
              onChange={(e) => setUtr(e.target.value)}
              placeholder="12 digits from your payment app"
              supportingText="Helps us match your payment faster. You can skip it."
            />
          </div>

          {(claimError || error) && (
            <p className="kw-body-small mt-3" style={{ color: "var(--color-error)" }}>{claimError || error}</p>
          )}

          <div className="mt-5">
            <Button variant="filled" fullWidth disabled={busy} onClick={claim}>
              {busy ? "Setting up…" : "I've completed the payment"}
            </Button>
          </div>

          <div className="mt-3 flex items-center justify-center gap-2">
            <ProgressIndicator variant="circular" size={16} />
            <p className="kw-body-small" style={{ color: "var(--color-on-surface-variant)" }}>
              Watching for your payment…
            </p>
          </div>

          <p className="kw-body-small mt-4 text-center" style={{ color: "var(--color-on-surface-variant)" }}>
            Your agent goes live straight away. We confirm the payment with our bank within 3 days.
          </p>

          <div className="mt-2 text-center">
            <Button variant="text" onClick={onCancel}>Back</Button>
          </div>
        </>
      )}
    </>
  );
}

export default UpiPayment;
