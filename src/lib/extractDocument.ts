import mammoth from "mammoth";

// Turns an uploaded document into the HTML shape chunkHtmlByHeadings expects.
//
// That chunker splits on <h1>-<h3> and captures <p>, <li> and <tr>, so every
// format here is normalised into those tags rather than each one growing its
// own chunking path. Getting this wrong is expensive and silent: an earlier
// version of the chunker dropped table and list content entirely, and the
// product answered from a knowledge base with the questions present and the
// answers missing.

export interface ExtractedDocument {
  html: string;
  /** Recorded on the chunks so the dashboard can show where content came from. */
  sourceType: "docx" | "pdf" | "xlsx";
  /** Stored alongside the original bytes so downloads get the right headers. */
  mimeType: string;
}

export class UnsupportedFileTypeError extends Error {
  constructor(filename: string) {
    super(
      `"${filename}" isn't a supported file type. Upload a Word document (.docx), ` +
        `a PDF (.pdf), or an Excel spreadsheet (.xlsx).`
    );
    this.name = "UnsupportedFileTypeError";
  }
}

export const SUPPORTED_EXTENSIONS = [".docx", ".pdf", ".xlsx"] as const;

const MIME_TYPES: Record<string, string> = {
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function escapeHtml(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function extensionOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

/** Roughly how much text belongs in one paragraph block before it stops being
 * retrievable. Embedding a whole document as one vector matches everything
 * weakly and nothing well; these become separate chunks instead. */
const PDF_MAX_BLOCK_CHARS = 700;

/** Longest a line can be and still plausibly be a heading rather than prose. */
const PDF_HEADING_MAX_CHARS = 70;

/** Splits on sentence ends WITHOUT losing characters.
 *
 * The previous implementation used String.match with
 * /[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g, which silently discarded any text it could
 * not match from the current position. A real customer document containing
 * "R.A.G" - a full stop followed by a letter rather than a space - made the
 * match starting at position 0 fail, so the engine skipped forward and threw
 * away the first 274 characters, including the document's opening heading and
 * two entire sections. Nothing errored; the content simply was not there.
 *
 * This scans by index instead and every branch appends a slice, so the pieces
 * always rejoin to exactly the input. There is a test asserting that. */
function splitIntoSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?") continue;
    const next = text[i + 1];
    // A boundary only when whitespace or end follows, so "R.A.G", "3.5" and
    // "Ltd." mid-sentence stay intact.
    if (next === undefined || /\s/.test(next)) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

function splitLongBlock(block: string): string[] {
  if (block.length <= PDF_MAX_BLOCK_CHARS) return [block];

  const out: string[] = [];
  let buf = "";
  for (const sentence of splitIntoSentences(block)) {
    // Start a new block once adding this sentence would overshoot, unless the
    // buffer is empty - a single sentence longer than the cap still has to go
    // somewhere, and breaking mid-sentence reads worse than an oversized block.
    if (buf && buf.length + sentence.length > PDF_MAX_BLOCK_CHARS) {
      out.push(buf.trim());
      buf = "";
    }
    buf += sentence;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Whether a line is a heading rather than a wrapped line of prose.
 *
 * PDFs carry no heading markup, so structure has to be inferred - and without
 * it a document collapses into one untitled blob, which retrieves far worse
 * than the same content as a .docx where mammoth supplies real <h1>/<h2>.
 *
 * Three signals together, checked against a real customer document:
 *  - Short. Prose wraps at the page width (~90 chars there), so a full-width
 *    line is never a heading.
 *  - Starts with a capital. A wrapped continuation begins mid-sentence and so
 *    usually starts lowercase ("optimise pay outs", "teams to aid decision
 *    making"), which is what separates it from a genuine heading.
 *  - The next line also starts with a capital letter. After a heading a new
 *    sentence begins; after a short *final* line of a paragraph, the next line
 *    tends to continue lowercase or start with a digit.
 */
function isHeadingLine(line: string, following: string[]): boolean {
  const t = line.trim();
  if (!t || t.length > PDF_HEADING_MAX_CHARS) return false;
  // Ending punctuation means it is a sentence, not a title.
  if (/[.,;:!?]$/.test(t)) return false;
  if (!/^[A-Z]/.test(t)) return false;

  const next = following.map((l) => l.trim()).find((l) => l.length > 0);
  // Trailing line with nothing after it is far more likely a stray fragment
  // than a heading for content that does not exist.
  if (!next) return false;
  return /^[A-Z]/.test(next);
}

export function pdfTextToHtml(text: string): string {
  const lines = text.split("\n");
  const parts: string[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    // Join the visual line wraps back into prose: extraction breaks lines at
    // the page width, and treating those as paragraph breaks would shred every
    // sentence into fragments too small to retrieve on.
    const block = paragraph.join(" ").replace(/\s+/g, " ").trim();
    paragraph = [];
    if (!block) return;
    for (const piece of splitLongBlock(block)) {
      if (piece.trim()) parts.push(`<p>${escapeHtml(piece.trim())}</p>`);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (isHeadingLine(trimmed, lines.slice(i + 1))) {
      flush();
      parts.push(`<h2>${escapeHtml(trimmed)}</h2>`);
      continue;
    }
    paragraph.push(trimmed);
  }
  flush();

  return parts.join("\n");
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });
  return pdfTextToHtml(text || "");
}

/** Each sheet becomes a heading plus one <tr> per row, which is exactly what the
 * chunker already understands from Word tables. Cells are joined with an em
 * dash so a chunk reads as "Product — Price — Notes" rather than losing the
 * association between a label and its value when spoken aloud. */
async function extractXlsx(buffer: Buffer): Promise<string> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  // exceljs declares its own Buffer type, which no longer matches Node's
  // generic Buffer<ArrayBufferLike>. The runtime value is the same object;
  // deriving the parameter type from the method keeps that narrow and honest
  // rather than reaching for `any`.
  type XlsxLoadData = Parameters<typeof workbook.xlsx.load>[0];
  await workbook.xlsx.load(buffer as unknown as XlsxLoadData);

  const parts: string[] = [];
  workbook.eachSheet((sheet) => {
    parts.push(`<h2>${escapeHtml(sheet.name)}</h2>`);
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v === null || v === undefined) return;
        // Formula cells carry both the expression and its computed result; the
        // result is what a caller is actually asking about.
        const text =
          typeof v === "object" && v !== null && "result" in v
            ? String((v as { result: unknown }).result ?? "")
            : typeof v === "object" && v !== null && "text" in v
              ? String((v as { text: unknown }).text ?? "")
              : String(v);
        if (text.trim()) cells.push(text.trim());
      });
      if (cells.length) parts.push(`<tr>${escapeHtml(cells.join(" — "))}</tr>`);
    });
  });
  return parts.join("\n");
}

export async function extractDocument(
  filename: string,
  buffer: Buffer
): Promise<ExtractedDocument> {
  const ext = extensionOf(filename);
  switch (ext) {
    case ".docx": {
      const { value } = await mammoth.convertToHtml({ buffer });
      return { html: value, sourceType: "docx", mimeType: MIME_TYPES[ext] };
    }
    case ".pdf":
      return { html: await extractPdf(buffer), sourceType: "pdf", mimeType: MIME_TYPES[ext] };
    case ".xlsx":
      return { html: await extractXlsx(buffer), sourceType: "xlsx", mimeType: MIME_TYPES[ext] };
    default:
      throw new UnsupportedFileTypeError(filename);
  }
}
