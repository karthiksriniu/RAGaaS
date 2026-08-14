import { describe, it, expect } from "vitest";
import { normalizeWebsite } from "../websiteUrl";

// The value is user-typed and goes to Anthropic's server-side web_fetch. The
// fetch happens on their infrastructure, so this cannot reach our network -
// but garbage should still be dropped rather than wasting a tool call.
describe("normalizeWebsite", () => {
  it("adds https when the scheme is missing", () => {
    expect(normalizeWebsite("bluebird.com")).toBe("https://bluebird.com/");
  });

  it("keeps an explicit scheme and path", () => {
    expect(normalizeWebsite("http://x.co/about")).toBe("http://x.co/about");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeWebsite("  bluebird.com  ")).toBe("https://bluebird.com/");
  });

  it("treats blank input as absent", () => {
    for (const v of ["", "   ", null, undefined]) expect(normalizeWebsite(v)).toBeNull();
  });

  it("rejects non-http schemes", () => {
    for (const v of ["file:///etc/passwd", "ftp://x.co", "javascript:alert(1)"]) {
      expect(normalizeWebsite(v), v).toBeNull();
    }
  });

  it("rejects hostnames that aren't public domains", () => {
    // No TLD, so not a site the model could meaningfully read.
    for (const v of ["localhost", "http://localhost:3000", "http://169.254.169.254"]) {
      expect(normalizeWebsite(v), v).toBeNull();
    }
  });

  it("rejects unparseable input", () => {
    expect(normalizeWebsite("h ttp://not a url")).toBeNull();
  });
});
