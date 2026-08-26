import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { extractDocument, UnsupportedFileTypeError, extensionOf } from "@/lib/extractDocument";
import { chunkHtmlByHeadings } from "@/lib/chunk";

// End-to-end through the real parsers on real files: an earlier chunker bug
// silently dropped every table and list, leaving a knowledge base with the
// questions present and the answers missing. Format support is only real if
// the content survives all the way to chunks.
describe("extractDocument", () => {
  it("pulls paragraphs out of a PDF and chunks them", async () => {
    const buf = readFileSync("/tmp/kbtest/test.pdf");
    const doc = await extractDocument("policy.pdf", buf);
    expect(doc.sourceType).toBe("pdf");
    expect(doc.mimeType).toBe("application/pdf");

    const chunks = chunkHtmlByHeadings(doc.html);
    const all = chunks.map((c) => c.text).join(" ");
    expect(all).toContain("30 days");
    expect(all).toContain("original packaging");
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("keeps spreadsheet rows intact, label with value", async () => {
    const buf = readFileSync("/tmp/kbtest/test.xlsx");
    const doc = await extractDocument("prices.xlsx", buf);
    expect(doc.sourceType).toBe("xlsx");

    const chunks = chunkHtmlByHeadings(doc.html);
    const all = chunks.map((c) => c.text).join(" ");
    // The price must stay attached to the service it belongs to.
    expect(all).toMatch(/Deep clean.*2500/);
    expect(all).toContain("Basic clean");
    // Both sheets, and sheet names become headings.
    expect(all).toContain("Monday");
    expect(chunks.some((c) => /Pricing|Hours/.test(c.heading ?? ""))).toBe(true);
  });

  it("rejects unsupported types with a message naming the file", async () => {
    await expect(extractDocument("notes.txt", Buffer.from("hi"))).rejects.toThrow(
      UnsupportedFileTypeError
    );
    await expect(extractDocument("notes.txt", Buffer.from("hi"))).rejects.toThrow(/notes\.txt/);
  });

  it("matches extensions case-insensitively", () => {
    expect(extensionOf("REPORT.PDF")).toBe(".pdf");
    expect(extensionOf("noext")).toBe("");
  });
});
