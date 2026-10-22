import type { ParsedTodosRunArgs } from "./types.ts";

/**
 * Parse `/todos run` / `/tasks run` arguments.
 *
 * Recognized flags:
 *   --parallel       enable parallel execution (defaults off)
 *   --dry-run        render the plan without dispatch
 *   --resume         resume an interrupted run
 *   --retry          retry failed/blocked tasks
 *   --yes            skip the confirmation step (required for actual execution)
 *   --only a,b,c     restrict to the listed labels or todo ids
 *   --deps label=a,b add explicit dependencies for a label
 *   --model label=m  override the subagent model for a label
 *   --files label=p,q restrict the files a task may touch
 *   --max-concurrency N
 */
export function parseTodosRunArgs(raw: string): ParsedTodosRunArgs | null {
  const trimmed = raw.trim();
  if (!/^(\/(tasks|todos)\s+run)(\s|$)/i.test(trimmed)) return null;
  const tokens = trimmed.slice(1).split(/\s+/);
  const args: ParsedTodosRunArgs = {
    parallel: false,
    dryRun: true, // default to dry-run; use --yes to actually execute
    raw,
    only: [],
    deps: {},
    model: {},
    files: {},
    maxConcurrency: 2,
    confirm: false,
  };
  let i = 2; // skip the command and "run"
  for (; i < tokens.length; i += 1) {
    const token = tokens[i];
    switch (token) {
      case "--parallel":
        args.parallel = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--yes":
        args.confirm = true;
        break;
      case "--resume":
        args.resume = true;
        break;
      case "--retry":
        args.retry = true;
        break;
      case "--only":
        args.only = parseCommaList(tokens[++i]);
        break;
      case "--deps": {
        const spec = tokens[++i];
        const match = /^(.+?)=(.+)$/.exec(spec ?? "");
        if (!match) return null;
        const key = match[1];
        const valueList = parseCommaList(match[2]);
        args.deps = args.deps ?? {};
        args.deps[key] = valueList;
        break;
      }
      case "--model": {
        const spec = tokens[++i];
        const match = /^(.+?)=(.+)$/.exec(spec ?? "");
        if (!match) return null;
        const key = match[1];
        const value = match[2];
        args.model = args.model ?? {};
        args.model[key] = value;
        break;
      }
      case "--files": {
        const spec = tokens[++i];
        const match = /^(.+?)=(.+)$/.exec(spec ?? "");
        if (!match) return null;
        const key = match[1];
        const valueList = parseCommaList(match[2]);
        args.files = args.files ?? {};
        args.files[key] = valueList;
        break;
      }
      case "--max-concurrency": {
        const value = Number(tokens[++i]);
        if (!Number.isSafeInteger(value) || value < 0) return null;
        args.maxConcurrency = value;
        break;
      }
      default:
        return null;
    }
  }
  return args;
}

function parseCommaList(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}
