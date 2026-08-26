export interface DocChunk {
  heading: string;
  text: string;
}

/** Heading used for content that appears before any real heading - a document
 * title page, usually. Synthetic: this word is nowhere in the source. */
const DEFAULT_HEADING = "Introduction";

/** Below this, a preamble is a title page rather than content of its own.
 *
 * Only the PREAMBLE is judged by length. Sections with a real heading are left
 * alone however short, because a short authored section is still an answer -
 * "Early Blight / Symptoms include dark spots on leaves." is 37 characters and
 * perfectly useful. Length alone is not the signal; the absence of an authored
 * heading is. */
const MAX_MERGED_PREAMBLE_CHARS = 100;

function stripTags(html: string): string {
  return html
    // Cell boundaries become a separator before tags are stripped; without
    // this, <td>A:</td><td>Apply X</td> collapses to "A:Apply X".
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, " \u2014 ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

interface HtmlSection {
  heading: string;
  paragraphs: string[];
}

/** Folds a short unheaded preamble into the section that follows it.
 *
 * Content before the first heading gets the synthetic DEFAULT_HEADING, and for
 * most documents that content is the title page. Embedded on its own it becomes
 * a tiny chunk that scores deceptively high - a short embedding is not diluted
 * by other topics, so it matches almost any question generically. On a real
 * tenant, "Introduction / Industry Use Cases Knowledge Base" (47 characters)
 * outranked the section that actually answered "how do we get started".
 *
 * Merged rather than dropped, so the title's words stay searchable under the
 * first real heading instead of being lost - this pipeline has already shipped
 * one bug that silently discarded document text.
 *
 * A LONG preamble is left alone: that is a document with real content before
 * its first heading, not a title page. Sections that carry an authored heading
 * are never merged, however short.
 */
function mergeShortPreamble(sections: HtmlSection[]): HtmlSection[] {
  if (sections.length < 2) return sections;

  const [first, ...rest] = sections;
  if (first.heading !== DEFAULT_HEADING) return sections;

  const body = first.paragraphs.join("\n\n");
  if (!body || body.length >= MAX_MERGED_PREAMBLE_CHARS) return sections;

  const [next, ...tail] = rest;
  return [{ heading: next.heading, paragraphs: [...first.paragraphs, ...next.paragraphs] }, ...tail];
}

/**
 * Splits mammoth-generated HTML into chunks at heading boundaries (h1/h2/h3),
 * further splitting any section that exceeds maxChars along paragraph breaks.
 *
 * Block-level content is p, li and tr. Matching only <p> silently dropped
 * every table row and list item in a source document - which, in a Q&A log
 * where answers sit in table cells or bullets, meant the questions were
 * ingested and the ANSWERS were not. Retrieval then returned questions with
 * an empty "A:", and the model filled the gap from its own general knowledge
 * while appearing grounded. Any block-level element that can carry prose must
 * be captured here.
 */
export function chunkHtmlByHeadings(html: string, maxChars = 1200): DocChunk[] {
  // <tr> rather than <td>: joining a row's cells into one line keeps a
  // "label | value" pair together, which reads far better after tag-stripping
  // than each cell becoming its own orphaned fragment.
  const blockRegex =
    /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>|<(?:p|li|tr)[^>]*>([\s\S]*?)<\/(?:p|li|tr)>/gi;

  const sections: HtmlSection[] = [];
  let current: HtmlSection = { heading: DEFAULT_HEADING, paragraphs: [] };
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
  for (const sec of mergeShortPreamble(sections)) {
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
