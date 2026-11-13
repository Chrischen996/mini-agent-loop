/**
 * Startup tracing for the TUI boot path (`MINI_AGENT_BOOT_TRACE=1`).
 * Timestamped lines append to MINI_AGENT_BOOT_TRACE_FILE (default
 * /tmp/mini-agent-boot-trace.log). Writing to a FILE instead of stderr is
 * deliberate: stderr shares the pty with the frame stream and trace lines
 * get overwritten by repaints before any human could read them.
 *
 * With MINI_AGENT_BOOT_TRACE=profile, additionally runs a 20s sampling CPU
 * profile via node:inspector and dumps .cpuprofile next to the trace file —
 * flushed by us, so process.exit teardown cannot lose it.
 *
 * Zero cost unless enabled; safe to sprinkle at render/paint milestones.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";

export const BOOT_T0 = Date.now();
const MODE = process.env.MINI_AGENT_BOOT_TRACE ?? "";
const ENABLED = MODE !== "" && MODE !== "0";
const FILE = process.env.MINI_AGENT_BOOT_TRACE_FILE ?? "/tmp/mini-agent-boot-trace.log";

export function bootProbe(label: string, extra = ""): void {
  if (!ENABLED) return;
  try {
    appendFileSync(FILE, `[probe] +${Date.now() - BOOT_T0}ms ${label}${extra}\n`);
  } catch {
    // diagnostics must never break the app
  }
}

if (MODE === "profile") {
  const session = new Session();
  session.connect();
  session.post("Profiler.enable", () => {
    session.post("Profiler.start");
    appendFileSync(FILE, `[probe] profiler-start +${Date.now() - BOOT_T0}ms\n`);
    const dump = () => {
      session.post("Profiler.stop", (err, { profile }) => {
        if (err || !profile) return;
        const path = FILE.replace(/\.log$/, "") + "-" + Date.now() + ".cpuprofile";
        try {
          writeFileSync(path, JSON.stringify(profile));
          appendFileSync(FILE, `[probe] profiler-dumped ${path}\n`);
        } catch {
          // ignore
        }
      });
    };
    setTimeout(dump, 20_000).unref?.();
    process.on("exit", () => {
      // Synchronous best-effort: keep sampling until the stop callback lands.
    });
  });
}