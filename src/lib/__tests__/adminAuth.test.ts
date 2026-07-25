import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  verifySessionToken,
} from "../adminAuth";

describe("hashPassword / verifyPassword", () => {
  it("round-trips a correct password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces a different salt each time (not deterministic)", () => {
    const a = hashPassword("same-password");
    const b = hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same-password", a)).toBe(true);
    expect(verifyPassword("same-password", b)).toBe(true);
  });

  it("handles a malformed stored hash without throwing", () => {
    expect(verifyPassword("anything", "not-a-valid-hash")).toBe(false);
    expect(verifyPassword("anything", "")).toBe(false);
    expect(verifyPassword("anything", "onlysalt:")).toBe(false);
  });
});

describe("createSessionToken / verifySessionToken", () => {
  beforeEach(() => {
    process.env.ADMIN_SESSION_SECRET = "test-session-secret";
  });

  it("round-trips a freshly created token", () => {
    const token = createSessionToken();
    expect(verifySessionToken(token)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const token = createSessionToken();
    const [expiry] = token.split(".");
    const tampered = `${expiry}.0000000000000000000000000000000000000000000000000000000000000000`;
    expect(verifySessionToken(tampered)).toBe(false);
  });

  it("rejects a tampered expiry (signature no longer matches)", () => {
    const token = createSessionToken();
    const [, signature] = token.split(".");
    const farFuture = String(Date.now() + 1000 * 60 * 60 * 24 * 365);
    expect(verifySessionToken(`${farFuture}.${signature}`)).toBe(false);
  });

  it("rejects an expired token", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const token = createSessionToken(); // expires 12h later, per SESSION_TTL_MS
      expect(verifySessionToken(token)).toBe(true);

      vi.setSystemTime(new Date("2026-01-02T00:00:00Z")); // 24h later - well past the 12h TTL
      expect(verifySessionToken(token)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects null/undefined tokens", () => {
    expect(verifySessionToken(null)).toBe(false);
    expect(verifySessionToken(undefined)).toBe(false);
  });

  it("rejects a malformed token", () => {
    expect(verifySessionToken("not-a-token")).toBe(false);
    expect(verifySessionToken("")).toBe(false);
    expect(verifySessionToken("123.")).toBe(false);
    expect(verifySessionToken(".abc")).toBe(false);
  });

  it("rejects when ADMIN_SESSION_SECRET is unset", () => {
    const token = createSessionToken();
    delete process.env.ADMIN_SESSION_SECRET;
    expect(verifySessionToken(token)).toBe(false);
  });

  it("a token signed with a different secret is rejected", () => {
    process.env.ADMIN_SESSION_SECRET = "secret-a";
    const token = createSessionToken();
    process.env.ADMIN_SESSION_SECRET = "secret-b";
    expect(verifySessionToken(token)).toBe(false);
  });
});
