import { describe, it, expect } from "vitest";
import { normalizeSipHost } from "@/lib/vobiz";

// Vobiz accepts a scheme-prefixed origination URI, stores it, reports the trunk
// active - and then refuses every inbound call with send_refuse. It cost a live
// production number and a call that answered "the number you have dialled is
// invalid", with nothing logged anywhere. One prefix was the whole difference
// between the working staging trunk and the dead production one.
describe("normalizeSipHost", () => {
  it("strips the sip: scheme Vobiz cannot route", () => {
    expect(normalizeSipHost("sip:332yj9mqlrk.sip.livekit.cloud")).toBe(
      "332yj9mqlrk.sip.livekit.cloud"
    );
  });

  it("leaves a bare host alone - the form staging proves works", () => {
    expect(normalizeSipHost("46zc4a8v6zd.sip.livekit.cloud")).toBe(
      "46zc4a8v6zd.sip.livekit.cloud"
    );
  });

  it("strips sips: too, and is not case-sensitive about it", () => {
    expect(normalizeSipHost("SIPS:host.example.com")).toBe("host.example.com");
    expect(normalizeSipHost("SIP:host.example.com")).toBe("host.example.com");
  });

  it("drops the // some consoles show after the scheme", () => {
    expect(normalizeSipHost("sip://host.example.com")).toBe("host.example.com");
  });

  it("trims whitespace, which a pasted env value routinely carries", () => {
    expect(normalizeSipHost("  sip:host.example.com  ")).toBe("host.example.com");
  });

  it("does not mangle a host that merely starts with the letters sip", () => {
    expect(normalizeSipHost("sipgateway.example.com")).toBe("sipgateway.example.com");
  });

  it("returns empty for a value that is nothing but a scheme, so config() rejects it", () => {
    expect(normalizeSipHost("sip:")).toBe("");
  });
});
