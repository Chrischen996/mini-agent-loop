const s = process.stdin;
for (const m of ["resume", "pause", "setRawMode", "ref", "unref"]) {
  const orig = s[m];
  s[m] = function (...args) {
    if (m !== "setRawMode" || this.isTTY) console.log("STDIN." + m, "called from:\n", new Error().stack.split("\n").slice(1, 7).join("\n"));
    else console.log("STDIN.setRawMode(" + args[0] + ") from:\n", new Error().stack.split("\n").slice(1, 7).join("\n"));
    return orig ? orig.apply(this, args) : undefined;
  };
}
import("ink").then(() => {
  setTimeout(() => {
    console.log("stdin readable after import:", s.readable, "listeners(resame)=0?");
    console.log("_getActiveHandles:", process._getActiveHandles().map(h => h === process.stdin ? "STDIN" : h.constructor.name));
    process.exit(0);
  }, 800);
});
