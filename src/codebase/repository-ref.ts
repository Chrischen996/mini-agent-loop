export type RepositoryRef = { repository: string; ref?: string };

const OWNER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export function parseRepositoryRef(input: string, explicitRef?: string): RepositoryRef {
  const raw = input.trim();
  if (!raw || raw.includes("\\") || raw.includes("@")) throw new Error("Invalid public GitHub repository");
  let value = raw;
  let ref = explicitRef?.trim() || undefined;
  if (value.startsWith("https://")) {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
      throw new Error("Only public github.com repositories are supported");
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || (parts.length > 2 && parts[2] !== "tree")) throw new Error("Invalid GitHub repository URL");
    value = parts.slice(0, 2).join("/");
    if (!ref && parts[2] === "tree") {
      ref = parts.slice(3).join("/");
      if (!ref) throw new Error("Repository tree URL is missing a ref");
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw new Error("Only public github.com repositories are supported");
  }
  const parts = value.split("/");
  if (parts.length === 2 && parts[1]!.endsWith(".git")) parts[1] = parts[1]!.slice(0, -4);
  if (parts.length !== 2 || !OWNER.test(parts[0]!) || !NAME.test(parts[1]!)) {
    throw new Error("Repository must be owner/repo or a public GitHub URL");
  }
  if (ref && (
    ref.startsWith("-") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".") ||
    ref.endsWith(".lock") ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.includes("@{") ||
    ref.includes("\\") ||
    /[\x00-\x20\x7f~^:?*\[]/.test(ref) ||
    ref.length > 256
  )) throw new Error("Invalid repository ref");
  return ref
    ? { repository: `${parts[0]}/${parts[1]}`, ref }
    : { repository: `${parts[0]}/${parts[1]}` };
}

export function repositoryCloneUrl(repository: string): string {
  return `https://github.com/${repository}.git`;
}
