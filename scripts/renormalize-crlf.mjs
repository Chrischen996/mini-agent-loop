// P0 hygiene: renormalize CRLF text files in the working tree to LF.
// .gitattributes already declares `* text=lf`; this just fixes files that
// were written (or touched on Windows) with CRLF terminators, so the
// git diff stops showing whole-file churn.
//
// Usage: node scripts/renormalize-crlf.mjs [path ...]
//   no args  -> scope is src, test, scripts
//   e.g.     -> node scripts/renormalize-crlf.mjs src docs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const args = process.argv.slice(2);
const scope = args.length === 0 ? ["src", "test", "scripts"] : args;
const out = execFileSync("git", ["ls-files", ...scope], {
  cwd: process.cwd(),
  encoding: "utf8",
});
const files = out.split("\n").filter(Boolean);

const crFiles = [];
let cleanCount = 0;
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (text.includes("\r")) {
    writeFileSync(file, text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
    crFiles.push(file);
  } else {
    cleanCount += 1;
  }
}

process.stdout.write(
  `renormalize: ${crFiles.length} CRLF -> LF, ${cleanCount} already LF, ${files.length} tracked in ${scope.join(",")}\n`,
);
for (const file of crFiles) process.stdout.write(`  ${file}\n`);
