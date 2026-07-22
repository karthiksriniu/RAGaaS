export interface DocChunk {
  heading: string;
  text: string;
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Splits mammoth-generated HTML into chunks at heading boundaries (h1/h2/h3),
 * further splitting any section that exceeds maxChars along paragraph breaks.
 */
export function chunkHtmlByHeadings(html: string, maxChars = 1200): DocChunk[] {
  const blockRegex = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>|<p[^>]*>([\s\S]*?)<\/p>/gi;

  interface Section {
    heading: string;
    paragraphs: string[];
  }

  const sections: Section[] = [];
  let current: Section = { heading: "Introduction", paragraphs: [] };
  let sawHeading = false;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) !== null) {
    if (match[1]) {
      if (sawHeading || current.paragraphs.length > 0) {
        sections.push(current);
      }
      current = { heading: stripTags(match[2]), paragraphs: [] };
      sawHeading = true;
    } else if (match[3] !== undefined) {
      const text = stripTags(match[3]);
      if (text) current.paragraphs.push(text);
    }
  }
  if (current.paragraphs.length > 0 || sawHeading) sections.push(current);

  const chunks: DocChunk[] = [];
  for (const sec of sections) {
    const body = sec.paragraphs.join("\n\n");
    if (!body) continue;

    if (body.length <= maxChars) {
      chunks.push({ heading: sec.heading, text: `${sec.heading}\n\n${body}` });
      continue;
    }

    let buf = "";
    for (const para of sec.paragraphs) {
      const candidate = buf ? `${buf}\n\n${para}` : para;
      if (candidate.length > maxChars && buf) {
        chunks.push({ heading: sec.heading, text: `${sec.heading}\n\n${buf}` });
        buf = para;
      } else {
        buf = candidate;
      }
    }
    if (buf) chunks.push({ heading: sec.heading, text: `${sec.heading}\n\n${buf}` });
  }

  return chunks;
}
