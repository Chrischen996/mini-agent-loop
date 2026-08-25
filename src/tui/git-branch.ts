import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Read the checked-out branch without invoking a shell. */
export async function getGitBranch(cwd: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, "branch", "--show-current"], {
      cwd,
      // Generous timeout: under parallel test load a cold git invocation can
      // take several seconds; a killed process would silently hide the branch.
      timeout: 5_000,
      maxBuffer: 4_096,
    });
    const branch = result.stdout.trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}
