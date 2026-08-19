import { describe, it, expect } from "vitest";
import { pdfTextToHtml } from "../extractDocument";

// PDFs have no heading structure, so how the text is cut into paragraphs is
// the only thing standing between "retrievable" and "one vector for the whole
// document". Measured on a real file: without the length split, a 40-line PDF
// produced exactly ONE chunk.
describe("pdfTextToHtml", () => {
  it("joins the visual line wraps inside a paragraph", () => {
    // Extraction breaks lines at the page width; treating those as paragraph
    // breaks would shred sentences into fragments too small to retrieve on.
    const html = pdfTextToHtml("We accept returns within\n30 days of purchase.");
    expect(html).toBe("<p>We accept returns within 30 days of purchase.</p>");
  });

  it("splits on blank lines when the PDF has them", () => {
    const html = pdfTextToHtml("Refund Policy\n\nShipping details here.");
    expect(html.match(/<p>/g)).toHaveLength(2);
  });

  it("splits an oversized block that has no blank lines at all", () => {
    const long = Array.from({ length: 40 }, (_, i) =>
      `Section ${i}. Customers ask about topic ${i} and we reply within ${i} days.`
    ).join("\n");
    const blocks = pdfTextToHtml(long).match(/<p>/g) || [];
    expect(blocks.length).toBeGreaterThan(1);
  });

  it("keeps blocks near the retrievable size rather than unbounded", () => {
    const long = "This is a sentence of a reasonable length. ".repeat(120);
    const texts = [...pdfTextToHtml(long).matchAll(/<p>(.*?)<\/p>/g)].map((m) => m[1]);
    // Allowed to overshoot slightly: a sentence is never broken mid-way.
    for (const t of texts) expect(t.length).toBeLessThan(900);
    expect(texts.length).toBeGreaterThan(5);
  });

  it("never breaks in the middle of a sentence", () => {
    const long = "Alpha beta gamma delta epsilon zeta eta theta. ".repeat(60);
    const texts = [...pdfTextToHtml(long).matchAll(/<p>(.*?)<\/p>/g)].map((m) => m[1]);
    for (const t of texts) expect(t.trim().endsWith(".")).toBe(true);
  });

  it("escapes HTML so document text cannot inject markup", () => {
    expect(pdfTextToHtml("5 < 10 & <b>bold</b>")).toContain("&lt;b&gt;");
  });

  it("drops empty input", () => {
    expect(pdfTextToHtml("")).toBe("");
    expect(pdfTextToHtml("   \n\n  ")).toBe("");
  });
});
