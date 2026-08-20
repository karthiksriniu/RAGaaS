import { describe, it, expect } from "vitest";
import { markdownToSimpleHtml } from "../markdownHtml";

// The chunker takes its section titles from <h1>-<h3>. If a generated document
// produces none, the whole thing becomes untitled ~1100-character chunks that
// each mix several topics - which is what a real tenant had: seven generated
// chunks, all titled "Introduction", with the "##" still in the text.
describe("markdownToSimpleHtml", () => {
  it("converts a heading followed immediately by its body", () => {
    // THE regression: the old version matched the heading regex against a
    // whole blank-line-delimited block, so a heading with body on the next
    // line never matched and the "##" survived as literal text.
    const html = markdownToSimpleHtml("## What we do\nPositive Integers is a decision science company.");
    expect(html).toBe("<h2>What we do</h2><p>Positive Integers is a decision science company.</p>");
    expect(html).not.toContain("#");
  });

  it("gives every section its own heading", () => {
    const html = markdownToSimpleHtml(
      ["## What we do", "We build models.", "", "## Pricing", "We do not publish prices.", "", "## Who We Work With", "Telecom and FMCG."].join("\n")
    );
    expect(html.match(/<h2>/g)).toHaveLength(3);
    expect(html).toContain("<h2>Pricing</h2>");
    expect(html).toContain("<h2>Who We Work With</h2>");
  });

  it("never leaves markdown markers in the text spoken to callers", () => {
    const html = markdownToSimpleHtml("# Title\nBody.\n## Sub\nMore body.\n### Deep\nEven more.");
    const text = html.replace(/<[^>]+>/g, "");
    expect(text).not.toMatch(/#/);
  });

  it("clamps heading levels below h1-h3 so they still start a section", () => {
    // The chunker only splits on h1-h3; an h4 would otherwise be invisible.
    const html = markdownToSimpleHtml("#### Deeply nested\nBody text.");
    expect(html).toContain("<h3>Deeply nested</h3>");
  });

  it("keeps bullet lists as list items", () => {
    const html = markdownToSimpleHtml("## Services\n- Data analysis\n- Dashboards");
    expect(html).toContain("<li>Data analysis</li>");
    expect(html).toContain("<li>Dashboards</li>");
  });

  it("separates a list that follows a paragraph without a blank line", () => {
    const html = markdownToSimpleHtml("We offer these:\n- One\n- Two");
    expect(html).toBe("<p>We offer these:</p><ul><li>One</li><li>Two</li></ul>");
  });

  it("joins wrapped prose lines into one paragraph", () => {
    const html = markdownToSimpleHtml("This sentence is\nwrapped across lines.");
    expect(html).toBe("<p>This sentence is wrapped across lines.</p>");
  });

  it("escapes markup in the source text", () => {
    expect(markdownToSimpleHtml("## A & B\n5 < 10")).toContain("&lt;");
    expect(markdownToSimpleHtml("## A & B\n5 < 10")).toContain("A &amp; B");
  });

  it("ignores empty input", () => {
    expect(markdownToSimpleHtml("")).toBe("");
    expect(markdownToSimpleHtml("\n\n   \n")).toBe("");
  });
});
