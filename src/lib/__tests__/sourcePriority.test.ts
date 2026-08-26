import { describe, it, expect } from "vitest";
import { rankBySourcePriority, isUploaded, UPLOADED_SOURCE_BOOST } from "../sourcePriority";
import type { RetrievedChunk } from "../contextBlock";

const chunk = (
  source_type: string,
  similarity: number,
  text = `${source_type}-${similarity}`
): RetrievedChunk =>
  ({ text, source_type, source_uri: `${source_type}.file`, page_or_row: null, similarity }) as RetrievedChunk;

describe("rankBySourcePriority", () => {
  it("puts an uploaded document above generated content of similar relevance", () => {
    // The case that motivated this: generated content outranking the
    // business's own document by a small margin.
    const ranked = rankBySourcePriority([chunk("generated", 0.45), chunk("pdf", 0.42)], 6);
    expect(ranked[0].source_type).toBe("pdf");
  });

  it("still lets clearly better generated content win", () => {
    // Uploaded documents do not cover everything - pricing often lives only in
    // the generated knowledge base - so this must not be an absolute rule.
    const ranked = rankBySourcePriority([chunk("generated", 0.60), chunk("docx", 0.30)], 6);
    expect(ranked[0].source_type).toBe("generated");
  });

  it("does not modify the similarity it reports", () => {
    // The no-match threshold is applied to the true similarity, so a boost
    // must never make a weak match look strong enough to answer from.
    const ranked = rankBySourcePriority([chunk("pdf", 0.31)], 6);
    expect(ranked[0].similarity).toBe(0.31);
  });

  it("orders several uploaded chunks among themselves by similarity", () => {
    const ranked = rankBySourcePriority(
      [chunk("pdf", 0.30), chunk("docx", 0.50), chunk("xlsx", 0.40)],
      6
    );
    expect(ranked.map((c) => c.similarity)).toEqual([0.5, 0.4, 0.3]);
  });

  it("trims to the requested limit", () => {
    const ranked = rankBySourcePriority(
      [chunk("pdf", 0.5), chunk("docx", 0.4), chunk("generated", 0.3), chunk("pdf", 0.2)],
      2
    );
    expect(ranked).toHaveLength(2);
  });

  it("is stable for equal scores", () => {
    const a = chunk("generated", 0.4, "first");
    const b = chunk("generated", 0.4, "second");
    expect(rankBySourcePriority([a, b], 6).map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("promotes an uploaded chunk from outside the top slots", () => {
    // Why the caller over-fetches: without extra candidates this chunk would
    // never have been seen, let alone promoted.
    const candidates = [
      chunk("generated", 0.50),
      chunk("generated", 0.49),
      chunk("generated", 0.48),
      chunk("pdf", 0.45),
    ];
    expect(rankBySourcePriority(candidates, 3)[0].source_type).toBe("pdf");
  });

  it("treats every uploaded format as uploaded, and only generated as generated", () => {
    for (const t of ["pdf", "docx", "xlsx"]) expect(isUploaded(chunk(t, 0.5))).toBe(true);
    expect(isUploaded(chunk("generated", 0.5))).toBe(false);
  });

  it("has a boost small enough to be a tiebreaker, not an override", () => {
    // A large boost would bury genuinely better answers; guard the intent.
    expect(UPLOADED_SOURCE_BOOST).toBeGreaterThan(0);
    expect(UPLOADED_SOURCE_BOOST).toBeLessThan(0.2);
  });

  it("handles an empty candidate list", () => {
    expect(rankBySourcePriority([], 6)).toEqual([]);
  });
});
