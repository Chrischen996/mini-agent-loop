import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse") as (buffer: Buffer) => Promise<{ text?: string; numpages?: number }>;
const mammoth = require("mammoth") as {
  extractRawText(options: { buffer: Buffer }): Promise<{ value?: string; messages?: Array<{ message?: string }> }>;
};

export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export type ParsedDocument = {
  name: string;
  mimeType: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  text: string;
  pages?: number;
};

function extension(name: string): string {
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index).toLowerCase() : "";
}

function isPdf(buffer: Buffer): boolean {
  return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
}

function isZip(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 2).toString("ascii") === "PK";
}

export async function parseDocumentUpload(
  name: string,
  buffer: Buffer,
  mimeType: string,
): Promise<ParsedDocument> {
  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${name} exceeds the 4MB attachment limit`);
  }

  const ext = extension(name);
  if (ext === ".pdf" || mimeType === "application/pdf") {
    if (!isPdf(buffer)) throw new Error(`${name} is not a valid PDF`);
    const parsed = await pdfParse(buffer);
    const text = parsed.text?.trim() ?? "";
    if (!text) throw new Error(`${name} does not contain extractable text`);
    return {
      name,
      mimeType: "application/pdf",
      text,
      pages: parsed.numpages,
    };
  }

  if (
    ext === ".docx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    if (!isZip(buffer)) throw new Error(`${name} is not a valid DOCX file`);
    const parsed = await mammoth.extractRawText({ buffer });
    const text = parsed.value?.trim() ?? "";
    if (!text) throw new Error(`${name} does not contain extractable text`);
    return {
      name,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      text,
    };
  }

  throw new Error(`Unsupported document type: ${name} (supported: .pdf, .docx)`);
}

export function documentTextPart(document: ParsedDocument, attachmentId?: string): string {
  const metadata = document.pages ? `, ${document.pages} page(s)` : "";
  return [
    `[Attached document: ${document.name}${metadata}${attachmentId ? `, attachmentId=${attachmentId}` : ""}]`,
    document.text,
    `[End attached document: ${document.name}]`,
  ].join("\n");
}
