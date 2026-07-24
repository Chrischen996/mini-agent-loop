import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  textPart,
  imagePart,
  visionAnalysisPart,
  normalizeToParts,
  hasImageParts,
  hasVisionAnalysisParts,
  messagesHaveImages,
  imageOmissionPlaceholder,
  replaceImagesWithPlaceholders,
  stripImages,
  visionAnalysisAsText,
  partsToPlainText,
  extractImageParts,
  extractTextParts,
  extractVisionAnalysisParts,
  contentAsString,
} from "../src/content.ts";
import type { AgentMessage, ImagePart as ImagePartType } from "../src/types.ts";

describe("factory functions", () => {
  it("textPart creates a text content part", () => {
    const part = textPart("hello");
    assert.deepEqual(part, { type: "text", text: "hello" });
  });

  it("imagePart creates an image content part", () => {
    const part = imagePart("image/png", "aW1hZ2U=", "photo.png");
    assert.deepEqual(part, {
      type: "image",
      mimeType: "image/png",
      data: "aW1hZ2U=",
      source: "photo.png",
    });
  });

  it("imagePart without source sets source undefined", () => {
    const part = imagePart("image/jpeg", "data");
    assert.equal(part.source, undefined);
  });

  it("visionAnalysisPart creates a vision analysis content part", () => {
    const part = visionAnalysisPart("A cat", "gpt-4o", ["img1.png", "img2.png"]);
    assert.deepEqual(part, {
      type: "vision_analysis",
      text: "A cat",
      model: "gpt-4o",
      sources: ["img1.png", "img2.png"],
    });
  });
});

describe("normalizeToParts", () => {
  it("converts a string to a single text part", () => {
    const parts = normalizeToParts("hello");
    assert.deepEqual(parts, [{ type: "text", text: "hello" }]);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(normalizeToParts(""), []);
  });

  it("passes through an array of parts unchanged", () => {
    const input = [textPart("a"), imagePart("image/png", "data")];
    const result = normalizeToParts(input);
    assert.equal(result, input);
  });
});

describe("hasImageParts", () => {
  it("returns true when content contains an image part", () => {
    assert.ok(hasImageParts([textPart("desc"), imagePart("image/png", "data")]));
  });

  it("returns false for text-only content", () => {
    assert.ok(!hasImageParts("just text"));
    assert.ok(!hasImageParts([textPart("text")]));
  });

  it("returns false for empty content", () => {
    assert.ok(!hasImageParts(""));
    assert.ok(!hasImageParts([]));
  });
});

describe("hasVisionAnalysisParts", () => {
  it("detects vision analysis parts", () => {
    assert.ok(hasVisionAnalysisParts([visionAnalysisPart("A cat", "model", ["src"])]));
  });

  it("returns false without vision parts", () => {
    assert.ok(!hasVisionAnalysisParts("plain text"));
    assert.ok(!hasVisionAnalysisParts([textPart("text")]));
  });
});

describe("messagesHaveImages", () => {
  it("detects images in user messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: [textPart("look"), imagePart("image/png", "data")] },
    ];
    assert.ok(messagesHaveImages(messages));
  });

  it("detects images in tool messages", () => {
    const messages: AgentMessage[] = [
      { role: "tool", toolCallId: "c1", name: "read", content: [imagePart("image/png", "data")] },
    ];
    assert.ok(messagesHaveImages(messages));
  });

  it("ignores images in assistant/system messages", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "you are an assistant" },
      { role: "assistant", content: "hello" },
    ];
    assert.ok(!messagesHaveImages(messages));
  });

  it("returns false for no images at all", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "just text" },
    ];
    assert.ok(!messagesHaveImages(messages));
  });
});

describe("imageOmissionPlaceholder", () => {
  it("includes model, source, and mime type", () => {
    const part = imagePart("image/png", "data", "screenshot.png");
    const placeholder = imageOmissionPlaceholder(part, "deepseek-v4");
    assert.match(placeholder, /deepseek-v4/);
    assert.match(placeholder, /screenshot\.png/);
    assert.match(placeholder, /image\/png/);
  });

  it("defaults source to 'image' when not provided", () => {
    const part = imagePart("image/jpeg", "data");
    const placeholder = imageOmissionPlaceholder(part, "model");
    assert.match(placeholder, /source=image/);
  });
});

describe("replaceImagesWithPlaceholders", () => {
  it("replaces image parts with text placeholders", () => {
    const content = [textPart("look"), imagePart("image/png", "data", "photo.png")];
    const result = replaceImagesWithPlaceholders(content, "deepseek");
    assert.equal(result.length, 2);
    assert.equal(result[0]!.type, "text");
    assert.equal(result[1]!.type, "text");
    if (result[1]!.type === "text") {
      assert.match(result[1]!.text, /Image omitted/);
    }
  });

  it("leaves non-image parts unchanged", () => {
    const content = [textPart("hello"), visionAnalysisPart("desc", "m", ["s"])];
    const result = replaceImagesWithPlaceholders(content, "model");
    assert.equal(result[0]!.type, "text");
    assert.equal(result[1]!.type, "vision_analysis");
  });
});

describe("stripImages", () => {
  it("removes all image parts", () => {
    const content = [
      textPart("a"),
      imagePart("image/png", "data"),
      visionAnalysisPart("b", "m", []),
      imagePart("image/jpeg", "data2"),
    ];
    const result = stripImages(content);
    assert.equal(result.length, 2);
    assert.ok(result.every((p) => p.type === "text" || p.type === "vision_analysis"));
  });

  it("returns empty array when all parts are images", () => {
    const result = stripImages([imagePart("image/png", "data")]);
    assert.equal(result.length, 0);
  });
});

describe("visionAnalysisAsText", () => {
  it("formats analysis with header and footer", () => {
    const part = visionAnalysisPart("A cat sitting on a mat", "gpt-4o", ["img.png"]);
    const text = visionAnalysisAsText(part);
    assert.match(text, /\[Vision analysis: model=gpt-4o; sources=img\.png\]/);
    assert.match(text, /A cat sitting on a mat/);
    assert.match(text, /\[End vision analysis\]/);
  });

  it("joins multiple sources with comma", () => {
    const part = visionAnalysisPart("desc", "model", ["a.png", "b.png"]);
    const text = visionAnalysisAsText(part);
    assert.match(text, /sources=a\.png, b\.png/);
  });
});

describe("partsToPlainText", () => {
  it("joins text parts with newlines", () => {
    const result = partsToPlainText([textPart("line 1"), textPart("line 2")]);
    assert.equal(result, "line 1\nline 2");
  });

  it("renders images as placeholder brackets", () => {
    const result = partsToPlainText([imagePart("image/png", "data", "photo.png")]);
    assert.equal(result, "[image:photo.png]");
  });

  it("uses mimeType when source is missing", () => {
    const result = partsToPlainText([imagePart("image/jpeg", "data")]);
    assert.equal(result, "[image:image/jpeg]");
  });

  it("renders vision analysis with header/footer", () => {
    const result = partsToPlainText([visionAnalysisPart("desc", "m", ["s"])]);
    assert.match(result, /\[Vision analysis/);
    assert.match(result, /\[End vision analysis\]/);
  });

  it("handles string input", () => {
    assert.equal(partsToPlainText("hello"), "hello");
  });
});

describe("extract* helpers", () => {
  const mixed = [
    textPart("t"),
    imagePart("image/png", "d"),
    visionAnalysisPart("v", "m", []),
    textPart("t2"),
    imagePart("image/jpeg", "d2"),
  ];

  it("extractImageParts returns only image parts", () => {
    const result = extractImageParts(mixed);
    assert.equal(result.length, 2);
    assert.ok(result.every((p) => p.type === "image"));
  });

  it("extractTextParts returns only text parts", () => {
    const result = extractTextParts(mixed);
    assert.equal(result.length, 2);
    assert.ok(result.every((p) => p.type === "text"));
  });

  it("extractVisionAnalysisParts returns only vision parts", () => {
    const result = extractVisionAnalysisParts(mixed);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.type, "vision_analysis");
  });
});

describe("contentAsString", () => {
  it("returns string content as-is", () => {
    assert.equal(contentAsString("hello world"), "hello world");
  });

  it("returns empty string for empty string input", () => {
    assert.equal(contentAsString(""), "");
  });

  it("converts parts to plain text", () => {
    const result = contentAsString([textPart("a"), textPart("b")]);
    assert.equal(result, "a\nb");
  });

  it("includes image placeholders", () => {
    const result = contentAsString([imagePart("image/png", "data", "photo.png")]);
    assert.equal(result, "[image:photo.png]");
  });
});
