import { describe, it, expect } from "vitest";
import { pdfTextToHtml } from "../extractDocument";

// PDFs carry no heading markup, so how the text is cut into blocks is the only
// thing standing between "retrievable" and "one untitled blob". Both defects
// below were found in a real customer document, not imagined.
describe("pdfTextToHtml", () => {
  describe("never loses text", () => {
    // THE regression. The old splitter used String.match with a sentence
    // regex; on text containing "R.A.G" (a full stop followed by a letter) the
    // match from position 0 failed, the engine skipped ahead, and 274
    // characters - the opening heading and two whole sections - were silently
    // dropped. Nothing threw. The document was simply incomplete.
    const words = (html: string) =>
      html
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .split(/\s+/)
        .filter(Boolean);

    it("keeps every word when the text contains dotted abbreviations", () => {
      const text =
        "Identifies ROI at product level - the model output is made\n" +
        "actionable through a R.A.G tracker with insights for the trade team";
      const input = text.split(/\s+/).filter(Boolean);
      expect(words(pdfTextToHtml(text))).toEqual(input);
    });

    it("keeps every word in a long document with abbreviations", () => {
      const text = Array.from(
        { length: 30 },
        (_, i) => `Item ${i} is handled by the R.A.G process and Ltd. partners within ${i} days.`
      ).join("\n");
      expect(words(pdfTextToHtml(text))).toEqual(text.split(/\s+/).filter(Boolean));
    });

    it("keeps every word when nothing is punctuated at all", () => {
      const text = Array.from({ length: 40 }, (_, i) => `heading fragment number ${i} with no full stop`).join("\n");
      expect(words(pdfTextToHtml(text))).toEqual(text.split(/\s+/).filter(Boolean));
    });
  });

  describe("paragraph assembly", () => {
    it("joins the visual line wraps inside a paragraph", () => {
      // Extraction breaks lines at the page width; treating those as paragraph
      // breaks would shred sentences into fragments too small to retrieve on.
      // "We accept returns within" is short and capitalised but is NOT a
      // heading, because the line after it starts with a digit rather than a
      // new capitalised sentence.
      const html = pdfTextToHtml("We accept returns within\n30 days of purchase.");
      expect(html).toBe("<p>We accept returns within 30 days of purchase.</p>");
    });

    it("splits an oversized block without breaking a sentence", () => {
      const long = "Alpha beta gamma delta epsilon zeta eta theta. ".repeat(60);
      const texts = [...pdfTextToHtml(long).matchAll(/<p>(.*?)<\/p>/g)].map((m) => m[1]);
      expect(texts.length).toBeGreaterThan(1);
      for (const t of texts) expect(t.trim().endsWith(".")).toBe(true);
    });
  });

  describe("heading detection", () => {
    // Structure recovered here is what makes a PDF retrieve as well as the
    // same content in a .docx, where mammoth supplies real <h1>/<h2>.
    const doc = [
      "FMCG",
      "Promoter Target Setting",
      "A Machine Learning model to arrive at optimum targets at a agent level to maximise sales and",
      "optimise pay outs",
      "Trade promotion evaluation",
      "Identifies ROI @ product/geo/trade scheme level - The XG Boost based model output is made",
      "actionable through a R.A.G tracker with insights for the trade team for future scheme designs",
    ].join("\n");

    it("promotes short capitalised lines followed by a new sentence", () => {
      const html = pdfTextToHtml(doc);
      expect(html).toContain("<h2>FMCG</h2>");
      expect(html).toContain("<h2>Promoter Target Setting</h2>");
      expect(html).toContain("<h2>Trade promotion evaluation</h2>");
    });

    it("does NOT promote a short lowercase continuation line", () => {
      // "optimise pay outs" ends a wrapped paragraph; as a heading it would
      // strand the sentence it belongs to.
      const html = pdfTextToHtml(doc);
      expect(html).not.toContain("<h2>optimise pay outs</h2>");
      expect(html).toContain("optimise pay outs</p>");
    });

    it("does not treat a line ending in punctuation as a heading", () => {
      const html = pdfTextToHtml("Refund Policy.\nWe accept returns.");
      expect(html).not.toContain("<h2>");
    });

    it("does not promote a trailing line with nothing after it", () => {
      const html = pdfTextToHtml("Some body text that runs on.\nDangling Fragment");
      expect(html).not.toContain("<h2>Dangling Fragment</h2>");
    });
  });

  it("escapes HTML so document text cannot inject markup", () => {
    expect(pdfTextToHtml("5 < 10 & <b>bold</b>")).toContain("&lt;b&gt;");
  });

  it("drops empty input", () => {
    expect(pdfTextToHtml("")).toBe("");
    expect(pdfTextToHtml("   \n\n  ")).toBe("");
  });
});
