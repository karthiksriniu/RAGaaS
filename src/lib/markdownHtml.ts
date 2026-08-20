// Converts the markdown the model writes into the HTML shape
// chunkHtmlByHeadings expects.
//
// Its own module, dependency-free, for the same reason as voicePresets.ts and
// websiteUrl.ts: ingestText.ts imports the database, so anything living there
// cannot be unit-tested without a live connection string - and this function
// silently broke every generated knowledge base once already.

/** Markdown headings become <h_> so chunkHtmlByHeadings splits on them, which
 * is what gives each chunk its heading. Everything else becomes a paragraph.
 * Deliberately minimal - this handles the headings/paragraph structure of
 * generated content, not arbitrary markdown. */
export function markdownToSimpleHtml(md: string): string {
  const escape = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Line by line, NOT block by block. The previous version split on blank
  // lines and matched /^(#{1,3})\s+(.*)$/ against the whole block, so a
  // heading immediately followed by its body - which is how the model actually
  // writes - never matched: `.` does not cross newlines and `$` without the m
  // flag means end of string. Every such block fell through to <p> with the
  // "##" left in as literal text, so a generated knowledge base became a
  // handful of ~1100-character chunks all titled "Introduction". Measured on a
  // real tenant, whose seven generated chunks shared one heading between them.
  const out: string[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${escape(paragraph.join(" ").replace(/\s+/g, " ").trim())}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    out.push(`<ul>${listItems.map((i) => `<li>${escape(i)}</li>`).join("")}</ul>`);
    listItems = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const rawLine of md.split("\n")) {
    const line = rawLine.trim();

    if (!line) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      // The chunker only splits on h1-h3; deeper markdown levels are clamped so
      // they still start a section rather than vanishing into a paragraph.
      const level = Math.min(heading[1].length, 3);
      const text = heading[2].trim();
      if (text) out.push(`<h${level}>${escape(text)}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (bullet[1].trim()) listItems.push(bullet[1].trim());
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushAll();

  return out.join("");
}
