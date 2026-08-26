import { describe, it, expect } from "vitest";
import {
  BlockedUrlError,
  htmlToText,
  isPrivateAddress,
  pageTitle,
  pickLinks,
  scrapeSite,
} from "../websiteScrape";

// We fetch a user-supplied URL from our own infrastructure now, which is the
// one thing the previous server-side-web_fetch design got for free. These tests
// are the replacement for that guarantee, so isPrivateAddress carries most of
// them - it is the function that must not be wrong.

describe("isPrivateAddress", () => {
  it("blocks the cloud metadata endpoint, which is the whole point", () => {
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    // The same address wearing an IPv6 hat.
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("blocks loopback and every RFC1918 range", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.254",
                      "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.1.100"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("blocks the ranges people forget: CGNAT, benchmarking, 0.0.0.0/8, multicast", () => {
    for (const ip of ["100.64.0.1", "100.127.255.255", "198.18.0.1", "198.19.1.1",
                      "0.0.0.0", "0.1.2.3", "224.0.0.1", "255.255.255.255"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("blocks IPv6 loopback, unique-local and link-local", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("allows ordinary public addresses, or nothing would ever be readable", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.183.14", "172.15.0.1",
                      "172.32.0.1", "192.167.0.1", "100.63.255.255", "100.128.0.1",
                      "2606:4700:4700::1111"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("treats anything it cannot parse as private - unproven is not public", () => {
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateAddress("1.2.3")).toBe(true);
    expect(isPrivateAddress("999.1.1.1")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("scrapeSite host checks", () => {
  it("refuses a host that resolves into our own network", async () => {
    await expect(scrapeSite("http://localhost:3000")).rejects.toThrow(BlockedUrlError);
  });

  it("refuses a bare IP - never a business's website, always a probe", async () => {
    await expect(scrapeSite("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      BlockedUrlError
    );
  });
});

describe("pickLinks", () => {
  const html = `
    <a href="/about-us">About</a>
    <a href="/our-services">Services</a>
    <a href="/pricing">Pricing</a>
    <a href="/faq">FAQ</a>
    <a href="/contact">Contact</a>
    <a href="/blog/why-we-started">Blog</a>
    <a href="/login">Login</a>
    <a href="/cart">Cart</a>
    <a href="https://facebook.com/thebusiness">Facebook</a>
    <a href="/brochure.pdf">Brochure</a>
    <a href="mailto:hi@example.com">Email</a>
    <a href="#top">Top</a>
    <a href="/about-us/">About again</a>
  `;

  it("takes the pages where a business describes itself", () => {
    const links = pickLinks(html, "https://example.com/", 6);
    expect(links).toContain("https://example.com/about-us");
    expect(links).toContain("https://example.com/our-services");
    expect(links).toContain("https://example.com/pricing");
    expect(links).toContain("https://example.com/faq");
  });

  it("never leaves the business's own domain - an off-domain link is somebody else's copy", () => {
    expect(pickLinks(html, "https://example.com/", 20).every((l) => l.startsWith("https://example.com/"))).toBe(true);
  });

  it("skips logins, carts, blogs, files and mailto", () => {
    const links = pickLinks(html, "https://example.com/", 20).join(" ");
    expect(links).not.toMatch(/login|cart|blog|\.pdf|mailto/);
  });

  it("does not fetch the same page twice over a trailing slash", () => {
    const links = pickLinks(html, "https://example.com/", 20);
    expect(links.filter((l) => l.includes("about-us"))).toHaveLength(1);
  });

  it("ranks by usefulness, not by document order", () => {
    const reordered = `<a href="/contact">C</a><a href="/about">A</a>`;
    expect(pickLinks(reordered, "https://example.com/", 1)).toEqual(["https://example.com/about"]);
  });

  it("honours the limit, so one link-heavy homepage cannot fan out", () => {
    expect(pickLinks(html, "https://example.com/", 2)).toHaveLength(2);
  });

  it("never returns the homepage it was given", () => {
    const self = `<a href="/">Home</a><a href="https://example.com">Home again</a><a href="/about">A</a>`;
    expect(pickLinks(self, "https://example.com/", 10)).toEqual(["https://example.com/about"]);
  });
});

describe("htmlToText", () => {
  it("drops script and style content rather than feeding it to the model", () => {
    const out = htmlToText(`<p>Open daily</p><script>var secret=1;alert("x")</script><style>.a{color:red}</style>`);
    expect(out).toContain("Open daily");
    expect(out).not.toMatch(/secret|alert|color:red/);
  });

  it("breaks block elements onto their own lines so headings don't run into prose", () => {
    expect(htmlToText("<h2>Pricing</h2><p>From 500 rupees</p>")).toBe("Pricing\nFrom 500 rupees");
  });

  it("decodes the entities that actually appear in page copy", () => {
    expect(htmlToText("<p>Tea &amp; coffee&nbsp;&#8212; all day</p>")).toBe("Tea & coffee — all day");
  });

  it("survives unclosed and malformed markup", () => {
    expect(htmlToText("<p>One<p>Two<div>Three")).toBe("One\nTwo\nThree");
  });
});

describe("pageTitle", () => {
  it("reads the title and collapses its whitespace", () => {
    expect(pageTitle("<html><head><title>  Sunrise\n  Dental  </title>")).toBe("Sunrise Dental");
  });

  it("returns empty rather than throwing when there is none", () => {
    expect(pageTitle("<html><body>hi</body></html>")).toBe("");
  });
});
