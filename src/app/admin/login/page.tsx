"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm"
      >
        <h1 className="text-lg font-semibold text-green-800">AgriAdvisor admin</h1>
        <p className="mt-1 text-sm text-neutral-500">Sign in to manage knowledge sources.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mt-4 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-green-600"
        />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !password}
          className="mt-4 w-full rounded-lg bg-green-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
