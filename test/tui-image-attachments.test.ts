import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React, { useState } from "react";
import { render } from "ink";
import {
  imageAttachmentToPart,
  loadImageAttachment,
  readClipboardImage,
} from "../src/tui/image-attachments.ts";
import {
  isImagePasteShortcut,
  PasteAwareTextInput,
} from "../src/tui/components/PasteAwareTextInput.tsx";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("TUI image attachments", () => {
  it("recognizes terminal Ctrl+V without treating plain v as image paste", () => {
    assert.equal(isImagePasteShortcut("v", { ctrl: true }), true);
    assert.equal(isImagePasteShortcut("\u0016", { ctrl: true }), true);
    assert.equal(isImagePasteShortcut("v", { ctrl: false }), false);
  });

  it("keeps Ctrl+V out of the controlled Ink input", async () => {
    const terminalIn = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: () => terminalIn,
      ref: () => terminalIn,
      unref: () => terminalIn,
    });
    const terminalOut = Object.assign(new PassThrough(), {
      isTTY: true,
      columns: 80,
      rows: 24,
    });
    let currentValue = "draft";
    let pasteCount = 0;

    function Harness(): React.ReactElement {
      const [value, setValue] = useState("draft");
      currentValue = value;
      return React.createElement(PasteAwareTextInput, {
        value,
        onChange: setValue,
        onPasteImage: () => { pasteCount += 1; },
      });
    }

    const app = render(React.createElement(Harness), {
      stdin: terminalIn as unknown as NodeJS.ReadStream,
      stdout: terminalOut as unknown as NodeJS.WriteStream,
      stderr: terminalOut as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      await nextFrame();
      terminalIn.write("x");
      await nextFrame();
      assert.equal(currentValue, "draftx");

      terminalIn.write("\u0016");
      await nextFrame();
      assert.equal(pasteCount, 1);
      assert.equal(currentValue, "draftx");
    } finally {
      app.unmount();
    }
  });

  it("loads and sniffs a local image instead of trusting its extension", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mini-agent-image-test-"));
    try {
      const filePath = join(directory, "screenshot.bin");
      await writeFile(filePath, ONE_PIXEL_PNG);

      const attachment = await loadImageAttachment("screenshot.bin", directory);
      assert.equal(attachment.path, filePath);
      assert.equal(attachment.mimeType, "image/png");
      assert.equal(attachment.size, ONE_PIXEL_PNG.byteLength);

      const part = await imageAttachmentToPart(attachment);
      assert.equal(part.type, "image");
      assert.equal(part.mimeType, "image/png");
      assert.equal(part.data, ONE_PIXEL_PNG.toString("base64"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects files whose bytes are not a supported image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mini-agent-image-test-"));
    try {
      const filePath = join(directory, "fake.png");
      await writeFile(filePath, "not an image");
      await assert.rejects(loadImageAttachment(filePath), /not a supported PNG, JPEG, GIF, or WebP/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("captures clipboard bytes in memory and removes the temporary file", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "mini-agent-clipboard-test-"));
    let exportedPath = "";
    try {
      const attachment = await readClipboardImage({
        platform: "darwin",
        tempRoot,
        now: () => 123,
        runClipboardExport: async (outputPath) => {
          exportedPath = outputPath;
          await writeFile(outputPath, ONE_PIXEL_PNG);
        },
      });

      assert.equal(attachment.path, "clipboard-123.png");
      assert.equal(attachment.mimeType, "image/png");
      assert.equal(attachment.data, ONE_PIXEL_PNG.toString("base64"));
      await assert.rejects(access(exportedPath), { code: "ENOENT" });

      const part = await imageAttachmentToPart(attachment);
      assert.equal(part.source, "clipboard-123.png");
      assert.equal(part.data, ONE_PIXEL_PNG.toString("base64"));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("reports unsupported platforms instead of silently ignoring paste", async () => {
    await assert.rejects(
      readClipboardImage({ platform: "linux" }),
      /supported on macOS/,
    );
  });
});
