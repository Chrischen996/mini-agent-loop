import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { parseDocumentUpload, type ParsedDocument } from "./attachments.ts";
import type { FileArtifact } from "./tools/types.ts";

// The ESM bundle conflicts with pdf-parse's legacy PDF.js under Node 24.
const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib") as typeof import("pdf-lib");

type Attachment = ParsedDocument & { id: string; sessionId: string; sourcePath: string };

type DocumentMetadata = {
  attachments: Array<{
    id: string;
    name: string;
    mimeType: ParsedDocument["mimeType"];
    text: string;
    pages?: number;
    sourceFile: string;
  }>;
  outputs: Array<{
    id: string;
    name: string;
    mimeType: string;
    size: number;
    outputFile: string;
  }>;
};

export type DocumentReplacement = { oldText: string; newText: string };

export type DocumentEditArgs = {
  attachmentId: string;
  replacements: DocumentReplacement[];
  outputFormat?: "docx" | "pdf";
  fileName?: string;
};

function safeBaseName(name: string): string {
  return path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, "_") || "document";
}

function replaceText(text: string, replacements: DocumentReplacement[]): string {
  let output = text;
  for (const replacement of replacements) {
    if (!replacement.oldText) throw new Error("oldText must be non-empty");
    const count = output.split(replacement.oldText).length - 1;
    if (count !== 1) throw new Error(`oldText must match exactly once, found ${count}`);
    output = output.replace(replacement.oldText, replacement.newText);
  }
  return output;
}

async function createDocx(text: string): Promise<Buffer> {
  const document = new Document({
    sections: [{
      children: text.split("\n").map((line) => new Paragraph({ children: [new TextRun(line)] })),
    }],
  });
  return Packer.toBuffer(document);
}

function pdfSafeText(text: string): string {
  return text.replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
}

async function createPdf(text: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontSize = 11;
  const lineHeight = 15;
  const margin = 48;
  const pageWidth = 612;
  const pageHeight = 792;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  for (const sourceLine of text.split("\n")) {
    const line = pdfSafeText(sourceLine);
    const words = line.split(/\s+/);
    let current = "";
    const lines: string[] = [];
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, fontSize) > pageWidth - margin * 2 && current) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    lines.push(current);
    for (const lineText of lines) {
      if (y < margin) {
        page = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      page.drawText(lineText, { x: margin, y, size: fontSize, font, color: rgb(0.12, 0.12, 0.12) });
      y -= lineHeight;
    }
  }
  return Buffer.from(await pdf.save());
}

export class DocumentStore {
  private readonly rootPromise: Promise<string>;
  private readonly attachments = new Map<string, Attachment>();
  private readonly sessions = new Map<string, Set<string>>();
  private readonly outputs = new Map<string, { sessionId: string; path: string; artifact: FileArtifact }>();
  private readonly editResults = new Map<string, FileArtifact>();

  constructor(dataDir?: string) {
    const root = path.resolve(dataDir ?? path.join(os.homedir(), ".mini-agent", "documents"));
    this.rootPromise = mkdir(root, { recursive: true }).then(() => root);
  }

  async createSession(sessionId: string): Promise<void> {
    this.sessions.set(sessionId, this.sessions.get(sessionId) ?? new Set());
    const root = await this.rootPromise;
    await mkdir(path.join(root, sessionId), { recursive: true });
  }

  async restoreSession(sessionId: string): Promise<void> {
    await this.createSession(sessionId);
    const root = await this.rootPromise;
    const sessionRoot = path.join(root, sessionId);
    let metadata: DocumentMetadata;
    try {
      metadata = JSON.parse(await readFile(path.join(sessionRoot, "documents.json"), "utf8")) as DocumentMetadata;
    } catch {
      return;
    }
    for (const item of metadata.attachments ?? []) {
      const sourcePath = path.join(sessionRoot, item.sourceFile);
      try {
        await readFile(sourcePath);
        const attachment: Attachment = {
          id: item.id,
          sessionId,
          sourcePath,
          name: item.name,
          mimeType: item.mimeType,
          text: item.text,
          ...(item.pages ? { pages: item.pages } : {}),
        };
        this.attachments.set(item.id, attachment);
        this.sessions.get(sessionId)!.add(item.id);
      } catch {
        // Ignore outputs whose source file was removed.
      }
    }
    for (const item of metadata.outputs ?? []) {
      const outputPath = path.join(sessionRoot, item.outputFile);
      try {
        await readFile(outputPath);
        this.outputs.set(item.id, {
          sessionId,
          path: outputPath,
          artifact: { id: item.id, name: item.name, mimeType: item.mimeType, size: item.size },
        });
      } catch {
        // Ignore missing generated files.
      }
    }
  }

  async removeSession(sessionId: string): Promise<void> {
    const ids = this.sessions.get(sessionId) ?? new Set<string>();
    for (const id of ids) this.attachments.delete(id);
    for (const [id, output] of this.outputs) {
      if (output.sessionId === sessionId) this.outputs.delete(id);
    }
    this.sessions.delete(sessionId);
    const root = await this.rootPromise;
    await rm(path.join(root, sessionId), { recursive: true, force: true });
  }

  async addUpload(sessionId: string, name: string, buffer: Buffer, mimeType: string): Promise<Attachment> {
    if (!this.sessions.has(sessionId)) await this.createSession(sessionId);
    const parsed = await parseDocumentUpload(name, buffer, mimeType);
    const id = `doc_${randomUUID()}`;
    const root = await this.rootPromise;
    const sourcePath = path.join(root, sessionId, `${id}-${safeBaseName(name)}`);
    await writeFile(sourcePath, buffer);
    const attachment = { ...parsed, id, sessionId, sourcePath };
    this.attachments.set(id, attachment);
    this.sessions.get(sessionId)!.add(id);
    await this.persistMetadata(sessionId);
    return attachment;
  }

  getAttachment(sessionId: string, id: string): Attachment {
    const attachment = this.attachments.get(id);
    if (!attachment || attachment.sessionId !== sessionId) throw new Error("Document attachment not found");
    return attachment;
  }

  getOutput(sessionId: string, id: string) {
    const output = this.outputs.get(id);
    if (!output || output.sessionId !== sessionId) throw new Error("File not found");
    return output;
  }

  async edit(sessionId: string, args: DocumentEditArgs, operationScope?: string): Promise<FileArtifact> {
    const attachment = this.getAttachment(sessionId, args.attachmentId);
    const editKey = operationScope
      ? `${sessionId}:${operationScope}:${args.attachmentId}`
      : `${sessionId}:${args.attachmentId}:${JSON.stringify(args.replacements)}:${args.outputFormat ?? "docx"}:${args.fileName ?? ""}`;
    const previous = this.editResults.get(editKey);
    if (previous) return { ...previous, reused: true };
    const text = replaceText(attachment.text, args.replacements);
    const outputFormat = args.outputFormat ?? "docx";
    const id = `file_${randomUUID()}`;
    const extension = outputFormat === "pdf" ? ".pdf" : ".docx";
    const requestedName = safeBaseName(args.fileName ?? attachment.name.replace(/\.[^.]+$/, ""));
    const name = requestedName.endsWith(extension) ? requestedName : `${requestedName}${extension}`;
    const root = await this.rootPromise;
    const outputPath = path.join(root, sessionId, `${id}-${name}`);
    const data = outputFormat === "pdf" ? await createPdf(text) : await createDocx(text);
    await writeFile(outputPath, data);
    const artifact: FileArtifact = {
      id,
      name,
      mimeType: outputFormat === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: data.byteLength,
    };
    this.outputs.set(id, { sessionId, path: outputPath, artifact });
    this.editResults.set(editKey, artifact);
    await this.persistMetadata(sessionId);
    return artifact;
  }

  private async persistMetadata(sessionId: string): Promise<void> {
    const root = await this.rootPromise;
    const sessionRoot = path.join(root, sessionId);
    const attachments = [...this.attachments.values()]
      .filter((item) => item.sessionId === sessionId)
      .map((item) => ({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        text: item.text,
        ...(item.pages ? { pages: item.pages } : {}),
        sourceFile: path.basename(item.sourcePath),
      }));
    const outputs = [...this.outputs.values()]
      .filter((item) => item.sessionId === sessionId)
      .map((item) => ({
        id: item.artifact.id,
        name: item.artifact.name,
        mimeType: item.artifact.mimeType,
        size: item.artifact.size,
        outputFile: path.basename(item.path),
      }));
    await writeFile(path.join(sessionRoot, "documents.json"), JSON.stringify({ attachments, outputs }, null, 2), "utf8");
  }
}
