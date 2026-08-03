import { describe, it, expect } from "vitest";
import { chunkHtmlByHeadings } from "../chunk";

describe("chunkHtmlByHeadings", () => {
  it("creates one chunk per heading with its paragraphs attached", () => {
    const html = `
      <h1>Early Blight</h1>
      <p>Symptoms include dark spots on leaves.</p>
      <h1>Late Blight</h1>
      <p>Symptoms include water-soaked lesions.</p>
    `;
    const chunks = chunkHtmlByHeadings(html);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading).toBe("Early Blight");
    expect(chunks[0].text).toContain("dark spots");
    expect(chunks[1].heading).toBe("Late Blight");
    expect(chunks[1].text).toContain("water-soaked");
  });

  it("puts content before the first heading under 'Introduction'", () => {
    const html = `<p>General overview text.</p><h1>Section One</h1><p>Detail.</p>`;
    const chunks = chunkHtmlByHeadings(html);
    expect(chunks[0].heading).toBe("Introduction");
    expect(chunks[0].text).toContain("General overview text");
  });

  it("strips HTML tags and decodes common entities", () => {
    const html = `<h1>Title</h1><p>Fertilizer &amp; water &lt;correctly&gt; applied &quot;on time&quot;.</p>`;
    const chunks = chunkHtmlByHeadings(html);
    expect(chunks[0].text).toContain('Fertilizer & water <correctly> applied "on time".');
    expect(chunks[0].text).not.toContain("<p>");
  });

  it("splits a section exceeding maxChars into multiple chunks at paragraph boundaries", () => {
    const longPara = "word ".repeat(50); // ~250 chars
    const html = `<h1>Big Section</h1>` + Array(10).fill(`<p>${longPara}</p>`).join("");
    const chunks = chunkHtmlByHeadings(html, 500);
    const sameHeading = chunks.filter((c) => c.heading === "Big Section");
    expect(sameHeading.length).toBeGreaterThan(1);
    for (const c of sameHeading) {
      expect(c.text.length).toBeLessThanOrEqual(500 + "Big Section".length + 2);
    }
  });

  it("skips empty sections (heading with no paragraphs)", () => {
    const html = `<h1>Empty</h1><h1>Has Content</h1><p>Real text here.</p>`;
    const chunks = chunkHtmlByHeadings(html);
    expect(chunks.find((c) => c.heading === "Empty")).toBeUndefined();
    expect(chunks.find((c) => c.heading === "Has Content")).toBeDefined();
  });

  it("returns an empty array for HTML with no headings or paragraphs", () => {
    expect(chunkHtmlByHeadings("<div>nothing recognized</div>")).toEqual([]);
  });
});

// Regression tests for a real data-loss bug: the chunker matched only <p> and
// headings, so every table cell and list item in a source document was
// silently discarded. In Homegrown's Q&A log the answers lived in those
// elements, so the KB ingested questions with an empty "A:" and the model
// invented answers from general knowledge while appearing grounded.
describe("block-level content that is not a paragraph", () => {
  it("keeps text inside table rows", () => {
    const html =
      `<h2>Dragon Fruit</h2><p>Case 11 — Q: flower set but not fruiting</p>` +
      `<table><tr><td>A:</td><td>Apply potassium sulphate 50g per plant at flowering.</td></tr></table>`;
    const text = chunkHtmlByHeadings(html).map((c) => c.text).join("\n");
    expect(text).toContain("potassium sulphate 50g per plant");
  });

  it("keeps a table row's cells on one line so label and value stay together", () => {
    const html = `<h2>H</h2><table><tr><td>A:</td><td>Do the thing.</td></tr></table>`;
    const text = chunkHtmlByHeadings(html).map((c) => c.text).join("\n");
    // Not "A:Do the thing." - the cell boundary must survive tag stripping.
    expect(text).toContain("A: — Do the thing.");
  });

  it("keeps text inside bulleted lists", () => {
    const html = `<h2>Rambutan</h2><p>A:</p><ul><li>Irrigate twice weekly</li><li>Mulch the basin</li></ul>`;
    const text = chunkHtmlByHeadings(html).map((c) => c.text).join("\n");
    expect(text).toContain("Irrigate twice weekly");
    expect(text).toContain("Mulch the basin");
  });

  it("keeps numbered list items too", () => {
    const html = `<h2>Steps</h2><ol><li>First step</li><li>Second step</li></ol>`;
    const text = chunkHtmlByHeadings(html).map((c) => c.text).join("\n");
    expect(text).toContain("First step");
    expect(text).toContain("Second step");
  });

  it("attributes recovered content to the heading it sits under", () => {
    const html = `<h2>Longan</h2><table><tr><td>Prune after harvest.</td></tr></table>`;
    const chunks = chunkHtmlByHeadings(html);
    const hit = chunks.find((c) => c.text.includes("Prune after harvest"));
    expect(hit?.heading).toBe("Longan");
  });
});
