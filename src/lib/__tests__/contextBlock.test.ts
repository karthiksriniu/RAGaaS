import { describe, it, expect } from "vitest";
import { buildContextBlock, type RetrievedChunk } from "../contextBlock";

function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    text: "Some chunk text.",
    source_type: "docx",
    source_uri: "kb.docx",
    page_or_row: null,
    similarity: 0.8,
    ...overrides,
  };
}

describe("buildContextBlock", () => {
  it("numbers chunks from 1, matching the [n] citations answers produce", () => {
    const block = buildContextBlock([
      chunk({ text: "First." }),
      chunk({ text: "Second." }),
      chunk({ text: "Third." }),
    ]);
    expect(block).toContain("[1] ");
    expect(block).toContain("[2] ");
    expect(block).toContain("[3] ");
    expect(block).not.toContain("[0] ");
  });

  it("preserves retrieval order, so [1] is always the closest match", () => {
    const block = buildContextBlock([
      chunk({ text: "CLOSEST", similarity: 0.9 }),
      chunk({ text: "FURTHEST", similarity: 0.3 }),
    ]);
    expect(block.indexOf("CLOSEST")).toBeLessThan(block.indexOf("FURTHEST"));
    expect(block).toMatch(/\[1\][^[]*CLOSEST/);
  });

  it("includes the source uri for each chunk", () => {
    const block = buildContextBlock([chunk({ source_uri: "exotic_fruits_kb.docx" })]);
    expect(block).toContain("(Source: exotic_fruits_kb.docx)");
  });

  it("appends page_or_row to the source when present", () => {
    const block = buildContextBlock([
      chunk({ source_uri: "kb.docx", page_or_row: "Dragon fruit — flowering" }),
    ]);
    expect(block).toContain("(Source: kb.docx — Dragon fruit — flowering)");
  });

  it("omits the separator entirely when page_or_row is null", () => {
    const block = buildContextBlock([chunk({ source_uri: "kb.docx", page_or_row: null })]);
    expect(block).toContain("(Source: kb.docx)");
    expect(block).not.toContain("kb.docx —");
  });

  it("separates chunks with a divider so they don't read as one document", () => {
    const block = buildContextBlock([chunk({ text: "A" }), chunk({ text: "B" })]);
    expect(block).toContain("---");
  });

  it("returns an empty string for no chunks rather than a stray divider", () => {
    expect(buildContextBlock([])).toBe("");
  });

  it("emits no divider for a single chunk", () => {
    const block = buildContextBlock([chunk({ text: "Only one." })]);
    expect(block).not.toContain("---");
  });
});
