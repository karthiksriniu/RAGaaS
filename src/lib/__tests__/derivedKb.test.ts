import { describe, it, expect } from "vitest";
import { buildDerivedKb, type DerivedKbSource } from "../derivedKb";

const AT = new Date("2026-07-31T12:00:00Z");

function source(uri: string, chunks: [string, string | null][], type = "docx"): DerivedKbSource {
  return {
    source_uri: uri,
    source_type: type,
    chunks: chunks.map(([text, page_or_row]) => ({ text, page_or_row })),
  };
}

describe("buildDerivedKb", () => {
  it("titles the document with the tenant name", () => {
    const { document } = buildDerivedKb({
      tenantName: "Homegrown Biotech",
      sources: [],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(document).toContain("# Homegrown Biotech — Knowledge Base");
  });

  it("stamps the generation date and warns against hand-editing", () => {
    const { document } = buildDerivedKb({
      tenantName: "T",
      sources: [],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(document).toContain("2026-07-31");
    expect(document).toContain("overwritten on the next export");
  });

  it("emits a section per source and a sub-section per heading", () => {
    const { document } = buildDerivedKb({
      tenantName: "T",
      sources: [
        source("fruits.docx", [
          ["Dragon fruit needs support.", "Dragon fruit"],
          ["Longan prefers shade.", "Longan"],
        ]),
      ],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(document).toContain("## fruits.docx");
    expect(document).toContain("### Dragon fruit");
    expect(document).toContain("### Longan");
    expect(document).toContain("Longan prefers shade.");
  });

  it("groups consecutive chunks that share a heading under one sub-section", () => {
    const { document } = buildDerivedKb({
      tenantName: "T",
      sources: [
        source("kb.docx", [
          ["First part.", "Pruning"],
          ["Second part.", "Pruning"],
        ]),
      ],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(document.match(/### Pruning/g)).toHaveLength(1);
    expect(document).toContain("First part.");
    expect(document).toContain("Second part.");
  });

  it("drops consecutive duplicate chunk text from overlapping chunk windows", () => {
    const { document } = buildDerivedKb({
      tenantName: "T",
      sources: [
        source("kb.docx", [
          ["Repeated passage.", "H"],
          ["Repeated passage.", "H"],
        ]),
      ],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(document.match(/Repeated passage\./g)).toHaveLength(1);
  });

  it("omits the heading level entirely when chunks have no page_or_row", () => {
    const { document } = buildDerivedKb({
      tenantName: "T",
      sources: [source("plain.txt", [["Body text.", null]], "txt")],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(document).toContain("Body text.");
    expect(document).not.toContain("###");
  });

  it("keeps the answer config OUT of the document and returns it as a prompt addendum", () => {
    const config = "Keep answers under 3 sentences.";
    const { document, systemPromptAddendum } = buildDerivedKb({
      tenantName: "T",
      sources: [source("kb.docx", [["Content.", null]])],
      answerConfigMd: config,
      generatedAt: AT,
    });
    // Style rules in the KB would only surface when semantically similar to
    // the caller's question - they belong in the always-in-context prompt.
    expect(document).not.toContain(config);
    expect(systemPromptAddendum).toBe(config);
  });

  it("returns a null addendum when the tenant has no answer config", () => {
    const { systemPromptAddendum } = buildDerivedKb({
      tenantName: "T",
      sources: [],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(systemPromptAddendum).toBeNull();
  });

  it("treats a whitespace-only answer config as absent", () => {
    const { systemPromptAddendum } = buildDerivedKb({
      tenantName: "T",
      sources: [],
      answerConfigMd: "   \n  ",
      generatedAt: AT,
    });
    expect(systemPromptAddendum).toBeNull();
  });

  it("names the business and lists source files in the description Sarvam routes on", () => {
    const { description } = buildDerivedKb({
      tenantName: "Homegrown Biotech",
      sources: [source("exotic_fruits_kb.docx", [["x", null]])],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(description).toContain("Homegrown Biotech");
    expect(description).toContain("exotic_fruits_kb.docx");
  });

  it("steers the description away from personal account data, per Sarvam's guidance", () => {
    const { description } = buildDerivedKb({
      tenantName: "T",
      sources: [source("kb.docx", [["x", null]])],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(description).toMatch(/personal account or order data/i);
  });

  it("truncates a long source list in the description rather than listing every file", () => {
    const many = Array.from({ length: 12 }, (_, i) => source(`doc${i}.docx`, [["x", null]]));
    const { description } = buildDerivedKb({
      tenantName: "T",
      sources: many,
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(description).toContain("and 4 more");
    expect(description).not.toContain("doc11.docx");
  });

  it("says the KB is empty rather than pretending it has content", () => {
    const { description } = buildDerivedKb({
      tenantName: "T",
      sources: [],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(description).toMatch(/empty/i);
  });

  it("reports stats matching what was actually emitted", () => {
    const { document, stats } = buildDerivedKb({
      tenantName: "T",
      sources: [
        source("a.docx", [["one", "H1"], ["two", "H2"]]),
        source("b.docx", [["three", null]]),
      ],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(stats.sourceCount).toBe(2);
    expect(stats.chunkCount).toBe(3);
    expect(stats.characterCount).toBe(document.length);
  });

  it("never leaves more than one blank line between blocks", () => {
    const { document } = buildDerivedKb({
      tenantName: "T",
      sources: [source("a.docx", [["x", "H"]]), source("b.docx", [["y", "H"]])],
      answerConfigMd: null,
      generatedAt: AT,
    });
    expect(document).not.toMatch(/\n{3,}/);
  });
});
