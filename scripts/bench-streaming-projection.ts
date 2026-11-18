/**
 * Streaming projection benchmark: simulates a code-heavy ~16k-char assistant
 * response arriving in 250-char deltas and measures the per-delta cost of the
 * document-layout live projection.
 *
 * - OLD path: `streamingAssistantRows(text, { width, thinkingMode })` — a FULL
 *   markdown parse + code highlight + wrap of the whole text on every delta
 *   (the behavior before the incremental cache).
 * - NEW path: same call with `cache: MessageHeightCache` — only the newly
 *   settled lines + the growing tail are projected; settled rows are cached.
 *
 * Run: npx tsx scripts/bench-streaming-projection.ts
 */
import { streamingAssistantRows, MessageHeightCache } from "../src/tui/message-viewport.ts";

function buildDoc(): string {
  const lines: string[] = [];
  lines.push("# Benchmark report", "");
  lines.push("Intro paragraph with **bold** and `inline code` markers plus prose that wraps around the terminal width so the wrap path runs multiple physical rows per source line for a realistic cost profile.");
  lines.push("");
  let total = lines.join("\n").length;
  let block = 0;
  while (total < 15_000) {
    const lang = block % 2 === 0 ? "ts" : "py";
    lines.push(`\`\`\`${lang}`);
    for (let i = 0; i < 12; i++) {
      const codeLine = lang === "ts"
        ? `const value${i} = compute(${i}, ${block * 100 + i}) * ${i + 1}; // block ${block} field ${i}`
        : `def compute_${i}(a, b):  # block ${block} field ${i}`;
      lines.push(codeLine.padEnd(110, " "));
    }
    lines.push("```");
    lines.push("");
    lines.push(`Paragraph ${block} continues the prose with a moderately long sentence so wrapping engages at 100 columns, keeping the per-delta cost dominated by the same shapes the terminal renderer handles in production.`);
    lines.push("");
    block++;
    total = lines.join("\n").length;
  }
  return lines.join("\n");
}

const doc = buildDoc();
const width = 100;
const thinkingMode = "hidden";
const step = 250;

// Sanity: the two paths must produce identical row text for the full document.
const fullNoCache = streamingAssistantRows(doc, { width, thinkingMode });
const cache = new MessageHeightCache();
// Feed deltas the way the renderer does, then check the final projection.
let text = doc.slice(0, step * 10);
for (let i = step * 10; i < doc.length; i += step) {
  text = doc.slice(0, i + step);
  streamingAssistantRows(text, { width, thinkingMode, cache });
}
const fullCached = streamingAssistantRows(doc, { width, thinkingMode, cache });
const textOf = (rows: readonly { text: string }[]) => rows.map((r) => r.text).join("\n");
if (textOf(fullNoCache) !== textOf(fullCached)) {
  console.error("MISMATCH between cached and full projections");
  process.exit(1);
}

function bench(name: string, useCache: boolean): void {
  const c = useCache ? new MessageHeightCache() : undefined;
  let t = doc.slice(0, step * 10);
  streamingAssistantRows(t, { width, thinkingMode, cache: c }); // warm
  const samples: number[] = [];
  const deltas = Math.ceil((doc.length - t.length) / step);
  for (let d = 0; d < deltas; d += 1) {
    t = doc.slice(0, Math.min(doc.length, t.length + step));
    const startedAt = performance.now();
    streamingAssistantRows(t, { width, thinkingMode, cache: c });
    samples.push(performance.now() - startedAt);
  }
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const max = Math.max(...samples);
  console.log(`${name.padEnd(8)} deltas=${String(deltas).padEnd(4)} avg=${avg.toFixed(3)}ms max=${max.toFixed(3)}ms`);
}

bench("OLD(no-cache)", false);
bench("NEW(cache)", true);
console.log(`document: ${doc.length} chars, ${doc.split("\n").length} lines`);
