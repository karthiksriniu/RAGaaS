"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/kiowa/Button";
import { Card } from "@/components/kiowa/Card";
import { TextField } from "@/components/kiowa/TextField";
import { Logo } from "@/components/Logo";

/** Business sign-in. Same OTP endpoints as signup - the mobile number is the
 * identity, and /verify decides whether this number already owns a tenant. */
export default function BusinessLogin() {
  const router = useRouter();
  const [mobile, setMobile] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [channel, setChannel] = useState<string>("none");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || "Something went wrong");
    return d;
  }

  async function requestCode() {
    setError(null); setBusy(true);
    try {
      const d = await post("/api/business/otp", { mobile });
      setDevCode(d.devCode ?? null);
      setChannel(d.channel ?? "none");
      setSent(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function verify() {
    setError(null); setBusy(true);
    try {
      const d = await post("/api/business/verify", { mobile, code });
      if (!d.existing) {
        setError("No account for this number yet — sign up first.");
        return;
      }
      router.push("/app");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-8 sm:py-16" style={{ background: "var(--color-surface)" }}>
      <div className="mb-8 flex items-center gap-3">
        <Logo size={32} />
        <span className="kw-title-medium" style={{ color: "var(--color-on-surface)" }}>MyBizCare</span>
      </div>
      <Card variant="elevated" padding={32} style={{ width: "100%", maxWidth: 420 }}>
        <h1 className="kw-headline-small mb-1">Sign in</h1>
        <p className="kw-body-medium mb-6" style={{ color: "var(--color-on-surface-variant)" }}>
          {sent && channel === "vobiz-voice"
            ? "We\u2019re calling you now \u2014 we\u2019ll read out your code."
            : sent && channel === "whatsapp"
              ? "We sent a code to your WhatsApp."
              : "We\u2019ll send a code to your mobile."}
        </p>

        <TextField fullWidth label="Mobile number" value={mobile} onChange={(e) => setMobile(e.target.value)} type="tel" disabled={sent} />

        {sent && (
          <>
            {devCode && (
              <p className="kw-body-small mt-4 rounded-lg p-3" style={{ background: "var(--color-tertiary-container)", color: "var(--color-on-tertiary-container)" }}>
                Staging: your code is <strong>{devCode}</strong>
              </p>
            )}
            <div className="mt-4">
              <TextField fullWidth label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
            </div>
          </>
        )}

        {error && <p className="kw-body-small mt-3" style={{ color: "var(--color-error)" }}>{error}</p>}

        <div className="mt-6">
          <Button variant="filled" fullWidth disabled={busy} onClick={sent ? verify : requestCode}>
            {busy ? "Please wait…" : sent ? "Sign in" : "Send code"}
          </Button>
        </div>

        <p className="kw-body-small mt-6 text-center" style={{ color: "var(--color-on-surface-variant)" }}>
          New here? <Link href="/signup" style={{ color: "var(--color-primary)" }}>Create an account</Link>
        </p>
      </Card>
    </div>
  );
}
