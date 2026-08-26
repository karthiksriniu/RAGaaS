import { describe, it, expect, beforeAll } from "vitest";
import { encodeOtpVoiceToken, decodeOtpVoiceToken, spokenDigits } from "../otpVoiceToken";

// This token is the ONLY access control on /api/business/otp/voice, which is
// public because Vobiz has to fetch it and cannot present a session. If a
// tampered or stale token decoded to anything usable, that endpoint would read
// an attacker's chosen code down the phone.

beforeAll(() => {
  process.env.ADMIN_SESSION_SECRET = "test-secret-for-otp-voice-token";
});

describe("otp voice token", () => {
  it("round-trips a code and mobile", () => {
    const t = encodeOtpVoiceToken({ code: "610389", mobile: "+919876543210" });
    expect(decodeOtpVoiceToken(t)).toEqual({ code: "610389", mobile: "+919876543210" });
  });

  it("does not carry the code in readable form", () => {
    const t = encodeOtpVoiceToken({ code: "610389", mobile: "+919876543210" });
    // The whole point: this string ends up in Vobiz's request logs.
    expect(t).not.toContain("610389");
    expect(Buffer.from(t, "base64url").toString("utf8")).not.toContain("610389");
  });

  it("rejects a tampered token rather than decoding it", () => {
    const t = encodeOtpVoiceToken({ code: "610389", mobile: "+919876543210" });
    const raw = Buffer.from(t, "base64url");
    raw[raw.length - 1] ^= 0xff; // flip bits in the ciphertext
    expect(decodeOtpVoiceToken(raw.toString("base64url"))).toBeNull();
  });

  it("rejects a token encrypted under a different secret", () => {
    const t = encodeOtpVoiceToken({ code: "610389", mobile: "+919876543210" });
    process.env.ADMIN_SESSION_SECRET = "a-completely-different-secret";
    expect(decodeOtpVoiceToken(t)).toBeNull();
    process.env.ADMIN_SESSION_SECRET = "test-secret-for-otp-voice-token";
  });

  it("rejects junk without throwing", () => {
    for (const junk of ["", "x", "!!!!", "a".repeat(200)]) {
      expect(() => decodeOtpVoiceToken(junk)).not.toThrow();
      expect(decodeOtpVoiceToken(junk)).toBeNull();
    }
  });
});

describe("spokenDigits", () => {
  // Read as a whole number, "610389" comes out as "six hundred and ten
  // thousand, three hundred and eighty-nine", which nobody can write down.
  it("separates every digit so the speech engine pauses between them", () => {
    expect(spokenDigits("610389")).toBe("6. 1. 0. 3. 8. 9.");
  });

  it("keeps leading zeros, which a numeric reading would lose", () => {
    expect(spokenDigits("004321")).toBe("0. 0. 4. 3. 2. 1.");
  });
});
