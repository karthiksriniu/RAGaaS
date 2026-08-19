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

/** PDFs carry no heading structure, only positioned text.
 *
 * Blank-line-separated blocks become paragraphs where the PDF has them, and
 * single newlines are joined: extraction breaks lines at the page's visual
 * width, so treating those as paragraph breaks would shred every sentence into
 * fragments too small to retrieve on.
 *
 * Many PDFs have no blank lines at all once extracted, which would leave the
 * entire document as ONE paragraph and therefore one chunk - measured on a real
 * file, so not hypothetical. Anything still oversized after that is split on
 * sentence boundaries, which keeps each chunk about one idea. */
function splitLongBlock(block: string): string[] {
  if (block.length <= PDF_MAX_BLOCK_CHARS) return [block];

  const sentences = block.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [block];
  const out: string[] = [];
  let buf = "";
  for (const sentence of sentences) {
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

export function pdfTextToHtml(text: string): string {
  return text
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\s*\n\s*/g, " ").trim())
    .filter((block) => block.length > 0)
    .flatMap(splitLongBlock)
    .map((block) => `<p>${escapeHtml(block)}</p>`)
    .join("\n");
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
