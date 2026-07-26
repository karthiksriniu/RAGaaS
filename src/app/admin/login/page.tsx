"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/kiowa/Button";
import { TextField } from "@/components/kiowa/TextField";
import { Card } from "@/components/kiowa/Card";
import { Logo } from "@/components/Logo";

export default function AdminLogin() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4" style={{ background: "var(--color-surface)" }}>
      <Card variant="elevated" padding={32} style={{ width: "100%", maxWidth: 380 }}>
        <form onSubmit={handleSubmit} className="flex flex-col">
          <div className="mb-1 flex items-center gap-2.5">
            <Logo size={28} />
            <h1 className="kw-title-large" style={{ fontFamily: "var(--font-brand)", fontWeight: "var(--weight-bold)", color: "var(--color-primary)" }}>
              MyBizCare admin
            </h1>
          </div>
          <p className="kw-body-medium mt-1" style={{ color: "var(--color-on-surface-variant)" }}>
            Sign in to manage knowledge sources.
          </p>
          <TextField
            type="password"
            autoFocus
            label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={!!error}
            style={{ marginTop: 20, width: "100%" }}
          />
          {error && (
            <p className="kw-body-small mt-2" style={{ color: "var(--color-error)" }}>
              {error}
            </p>
          )}
          <Button type="submit" variant="filled" fullWidth disabled={submitting || !password} style={{ marginTop: 20 }}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
