import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  Download,
  Folder,
  ImagePlus,
  LoaderCircle,
  MessageSquarePlus,
  RotateCcw,
  Search,
  Send,
  Square,
  Settings2,
  User,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

type AppConfig = {
  model: string;
  modelVision: boolean;
  visionPreprocessor: "enabled" | "disabled";
  contextWindow?: number;
  workspace: string;
  workspaceLabel?: string;
  maxImages: number;
  maxImageBytes: number;
  maxAttachments: number;
};

type UserMessageItem = {
  id: string;
  kind: "user";
  content: string;
  images?: Array<{ name: string; url: string }>;
  referencedPaths?: string[];
  documents?: Array<{ name: string; size: number }>;
};

type TextPart = {
  type: "text";
  id: string;
  content: string;
  streaming?: boolean;
};

type ToolPart = {
  type: "tool";
  id: string;
  name: string;
  status: "running" | "done" | "error";
  details?: string;
  preview?: string;
  open?: boolean;
};

type AssistantPart = TextPart | ToolPart;

type AssistantTurnItem = {
  id: string;
  kind: "assistant_turn";
  parts: AssistantPart[];
};

type ErrorItem = {
  id: string;
  kind: "error";
  content: string;
  retryable?: boolean;
};

type FileReadyItem = {
  id: string;
  kind: "file";
  name: string;
  size: number;
  downloadUrl: string;
};

type PermissionItem = {
  id: string;
  kind: "permission";
  requestId: string;
  tool: string;
  risk: "medium" | "high";
  status: "pending" | "allow" | "deny";
};

type TimelineItem = UserMessageItem | AssistantTurnItem | ErrorItem | FileReadyItem | PermissionItem;

type PendingImage = {
  id: string;
  file: File;
  url: string;
};

type PendingDocument = {
  id: string;
  file: File;
};

type Draft = {
  text: string;
  images: PendingImage[];
  documents: PendingDocument[];
  referencedPaths: string[];
};

type StreamEvent = {
  type: string;
  [key: string]: unknown;
};

type WorkspaceEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
};

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  expanded?: boolean;
  loading?: boolean;
  children?: TreeNode[];
  error?: string;
  truncated?: boolean;
};

type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  qualifiedId: string;
  capabilities: { input: string[]; tools: boolean };
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
};

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const ACCEPTED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

function hasAssistantAfterLastUser(items: TimelineItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.kind === "assistant_turn") return true;
    if (items[i]?.kind === "user") return false;
  }
  return false;
}


function formatTokenCount(value: number): string {
  if (value >= 1000) {
    const k = value / 1000;
    return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(value);
}

function estimateTokensFromText(text: string): number {
  // Rough mixed CJK/Latin estimate for UI only.
  return Math.max(0, Math.ceil(text.length / 3));
}

function estimateUsedTokens(items: TimelineItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.kind === "user") {
      total += estimateTokensFromText(item.content);
      if (item.referencedPaths) {
        total += estimateTokensFromText(item.referencedPaths.join("\n"));
      }
      continue;
    }
    if (item.kind === "assistant_turn") {
      for (const part of item.parts) {
        if (part.type === "text") total += estimateTokensFromText(part.content);
        else {
          total += estimateTokensFromText(part.details ?? "");
          total += estimateTokensFromText(part.preview ?? "");
        }
      }
    }
  }
  return total;
}

function makeId(): string {
  return crypto.randomUUID();
}

function clipboardImageName(type: string, index: number): string {
  const extension = type.split("/")[1] === "jpeg" ? "jpg" : type.split("/")[1] ?? "png";
  const stamp = Date.now();
  return `pasted-image-${stamp}-${index + 1}.${extension}`;
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

async function fetchWorkspaceList(pathValue: string): Promise<{
  path: string;
  entries: WorkspaceEntry[];
  truncated: boolean;
}> {
  const query = pathValue ? `?path=${encodeURIComponent(pathValue)}` : "";
  const response = await fetch(`/api/workspace/list${query}`);
  if (!response.ok) throw new Error(await readError(response));
  return (await response.json()) as {
    path: string;
    entries: WorkspaceEntry[];
    truncated: boolean;
  };
}

function updateTreeNode(
  nodes: TreeNode[],
  pathValue: string,
  updater: (node: TreeNode) => TreeNode,
): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === pathValue) return updater(node);
    if (node.children) {
      return { ...node, children: updateTreeNode(node.children, pathValue, updater) };
    }
    return node;
  });
}
function formatToolDetails(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.path === "string") return parsed.path;
      return raw;
    } catch {
      return raw;
    }
  }
  if (typeof raw === "object" && raw !== null && "path" in raw) {
    return String((raw as { path: unknown }).path);
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function ensureAssistantTurn(
  items: TimelineItem[],
  turnIdRef: { current: string | null },
): { items: TimelineItem[]; turnId: string } {
  if (turnIdRef.current) {
    const exists = items.some(
      (item) => item.kind === "assistant_turn" && item.id === turnIdRef.current,
    );
    if (exists) return { items, turnId: turnIdRef.current };
  }
  const turnId = makeId();
  turnIdRef.current = turnId;
  return {
    items: [...items, { id: turnId, kind: "assistant_turn", parts: [] }],
    turnId,
  };
}

function patchAssistantTurn(
  items: TimelineItem[],
  turnId: string,
  patcher: (parts: AssistantPart[]) => AssistantPart[],
): TimelineItem[] {
  return items.map((item) => {
    if (item.kind !== "assistant_turn" || item.id !== turnId) return item;
    return { ...item, parts: patcher(item.parts) };
  });
}

function ToolCard({
  part,
  onToggle,
}: {
  part: ToolPart;
  onToggle: (id: string) => void;
}) {
  const canExpand = part.status !== "running" && Boolean(part.preview);
  return (
    <div className={`tool-card ${part.status}${part.open ? " open" : ""}`}>
      <button
        type="button"
        className="tool-card-header"
        onClick={() => {
          if (canExpand) onToggle(part.id);
        }}
        disabled={!canExpand}
        title={part.details || part.name}
      >
        <span className="tool-card-status">
          {part.status === "running" ? (
            <LoaderCircle className="spin" size={13} />
          ) : part.status === "error" ? (
            <AlertCircle size={13} />
          ) : (
            <Check size={13} />
          )}
        </span>
        <strong>{part.name}</strong>
        <span className="tool-card-summary">
          {part.details || (part.status === "running" ? "执行中…" : "")}
        </span>
        {canExpand ? (
          part.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />
        ) : (
          <span className="tool-card-spacer" />
        )}
      </button>
      {part.open && part.preview && (
        <pre className="tool-card-preview">{part.preview}</pre>
      )}
    </div>
  );
}

function ToolsGroup({
  tools,
  onToggle,
}: {
  tools: ToolPart[];
  onToggle: (id: string) => void;
}) {
  const running = tools.some((tool) => tool.status === "running");
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (running) {
      setExpanded(true);
      return;
    }
    if (tools.length >= 3) setExpanded(false);
  }, [running, tools.length]);

  if (tools.length === 0) return null;

  if (!expanded && !running) {
    const errors = tools.filter((tool) => tool.status === "error").length;
    return (
      <button
        type="button"
        className="tools-group-summary"
        onClick={() => setExpanded(true)}
      >
        <Wrench size={13} />
        <span>
          使用了 {tools.length} 个工具
          {errors > 0 ? ` · ${errors} 个失败` : ""}
        </span>
        <ChevronRight size={13} />
      </button>
    );
  }

  return (
    <div className={`tools-group${running ? " running" : ""}`}>
      <div className="tools-group-header">
        <span>
          <Wrench size={12} />
          工具调用 · {tools.length}
        </span>
        {!running && (
          <button type="button" onClick={() => setExpanded(false)}>
            收起
          </button>
        )}
      </div>
      <div className="tools-group-list">
        {tools.map((tool) => (
          <ToolCard key={tool.id} part={tool} onToggle={onToggle} />
        ))}
      </div>
    </div>
  );
}

function TreeRows({
  nodes,
  depth,
  selected,
  onToggleDir,
  onToggleFile,
}: {
  nodes: TreeNode[];
  depth: number;
  selected: Set<string>;
  onToggleDir: (node: TreeNode) => void;
  onToggleFile: (path: string) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isSelected = selected.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              className={`tree-row ${node.type} ${isSelected ? "selected" : ""}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => {
                if (node.type === "dir") onToggleDir(node);
                else onToggleFile(node.path);
              }}
              title={node.path}
            >
              <span className="tree-icon">
                {node.type === "dir" ? (
                  node.loading ? (
                    <LoaderCircle className="spin" size={14} />
                  ) : node.expanded ? (
                    <ChevronDown size={14} />
                  ) : (
                    <ChevronRight size={14} />
                  )
                ) : (
                  <FileCode2 size={14} />
                )}
              </span>
              {node.type === "dir" ? <Folder size={14} /> : null}
              <span className="tree-name">{node.name}</span>
            </button>
            {node.error && (
              <div className="tree-error" style={{ paddingLeft: 24 + depth * 14 }}>
                {node.error}
              </div>
            )}
            {node.expanded && node.children && (
              <TreeRows
                nodes={node.children}
                depth={depth + 1}
                selected={selected}
                onToggleDir={onToggleDir}
                onToggleFile={onToggleFile}
              />
            )}
            {node.expanded && node.truncated && (
              <div className="tree-error" style={{ paddingLeft: 24 + depth * 14 }}>
                目录项过多，已截断
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [documents, setDocuments] = useState<PendingDocument[]>([]);
  const [referencedPaths, setReferencedPaths] = useState<string[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryDraft, setRetryDraft] = useState<Draft | null>(null);
  const [pendingQueue, setPendingQueue] = useState<Draft[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [activeContextWindow, setActiveContextWindow] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelSearchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const objectUrls = useRef(new Set<string>());
  const activeTurnIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const selectedSet = useMemo(() => new Set(referencedPaths), [referencedPaths]);

  const requestSession = async (): Promise<string> => {
    const response = await fetch("/api/sessions", { method: "POST" });
    if (!response.ok) throw new Error(await readError(response));
    const data = (await response.json()) as { id: string };
    return data.id;
  };

  const loadRootTree = useCallback(async () => {
    setTreeLoading(true);
    setTreeError(null);
    try {
      const result = await fetchWorkspaceList("");
      setTree(result.entries.map((entry) => ({ ...entry })));
      if (result.truncated) setTreeError("根目录项过多，已截断显示");
    } catch (err) {
      setTree([]);
      setTreeError(err instanceof Error ? err.message : String(err));
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/config").then(async (response) => {
        if (!response.ok) throw new Error(await readError(response));
        return (await response.json()) as AppConfig;
      }),
      requestSession(),
    ])
      .then(([nextConfig, nextSessionId]) => {
        if (active) {
          setConfig(nextConfig);
          setSessionId(nextSessionId);
        }
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    if (config) void loadRootTree();
  }, [config, loadRootTree]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [items, busy]);

  const ready = Boolean(config && sessionId && !busy);
  const visionLabel = useMemo(() => {
    if (!config) return "检查中";
    if (config.modelVision) return "模型原生视觉";
    return config.visionPreprocessor === "enabled" ? "视觉预处理" : "文本模式";
  }, [config]);

  const usedTokens = useMemo(() => estimateUsedTokens(items), [items]);
  const contextWindow = config?.contextWindow ?? 0;

  const workspaceLabel = config?.workspaceLabel || config?.workspace || "-";

  const toggleReferencedPath = (pathValue: string) => {
    setReferencedPaths((current) =>
      current.includes(pathValue)
        ? current.filter((item) => item !== pathValue)
        : [...current, pathValue],
    );
  };

  const toggleDir = async (node: TreeNode) => {
    if (node.type !== "dir") return;
    if (node.expanded) {
      setTree((current) =>
        updateTreeNode(current, node.path, (item) => ({ ...item, expanded: false })),
      );
      return;
    }
    if (node.children) {
      setTree((current) =>
        updateTreeNode(current, node.path, (item) => ({ ...item, expanded: true })),
      );
      return;
    }
    setTree((current) =>
      updateTreeNode(current, node.path, (item) => ({
        ...item,
        loading: true,
        error: undefined,
      })),
    );
    try {
      const result = await fetchWorkspaceList(node.path);
      setTree((current) =>
        updateTreeNode(current, node.path, (item) => ({
          ...item,
          loading: false,
          expanded: true,
          truncated: result.truncated,
          children: result.entries.map((entry) => ({ ...entry })),
        })),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTree((current) =>
        updateTreeNode(current, node.path, (item) => ({
          ...item,
          loading: false,
          expanded: true,
          error: message,
          children: [],
        })),
      );
    }
  };

  const resetSession = async () => {
    if (busy) return;
    setError(null);
    try {
      if (sessionId) {
        await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      }
      setSessionId(await requestSession());
      setItems([]);
      setPrompt("");
      setRetryDraft(null);
      setReferencedPaths([]);
      setPendingQueue([]);
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
      objectUrls.current.clear();
      setImages([]);
      setDocuments([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const addImages = (files: Iterable<File>) => {
    if (!config) return;
    setError(null);
    const candidates = Array.from(files);
    const available = Math.max(0, config.maxImages - images.length);
    const selected = candidates.slice(0, available);
    const next: PendingImage[] = [];
    let firstError: string | null = null;
    if (candidates.length > available || (available === 0 && candidates.length > 0)) {
      firstError = `最多添加 ${config.maxImages} 张图片`;
    }
    for (const file of selected) {
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        firstError ??= `${file.name} 不是支持的图片`;
        continue;
      }
      if (file.size > config.maxImageBytes) {
        firstError ??= `${file.name} 超过 4MB`;
        continue;
      }
      const url = URL.createObjectURL(file);
      objectUrls.current.add(url);
      next.push({ id: makeId(), file, url });
    }
    setImages((current) => [...current, ...next]);
    if (firstError) setError(firstError);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const addDocuments = (files: Iterable<File>) => {
    if (!config) return;
    setError(null);
    const candidates = Array.from(files);
    const available = Math.max(0, config.maxAttachments - images.length - documents.length);
    const selected = candidates.slice(0, available);
    const next: PendingDocument[] = [];
    let firstError: string | null = null;
    if (candidates.length > available) firstError = `最多添加 ${config.maxAttachments} 个附件`;
    for (const file of selected) {
      if (!ACCEPTED_DOCUMENT_TYPES.has(file.type) && !/\.(pdf|docx)$/i.test(file.name)) {
        firstError ??= `${file.name} 不是支持的文档`;
        continue;
      }
      if (file.size > config.maxImageBytes) {
        firstError ??= `${file.name} 超过 4MB`;
        continue;
      }
      next.push({ id: makeId(), file });
    }
    setDocuments((current) => [...current, ...next]);
    if (firstError) setError(firstError);
    if (documentInputRef.current) documentInputRef.current.value = "";
  };

  const removeDocument = (id: string) => {
    setDocuments((current) => current.filter((document) => document.id !== id));
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!config || busy) return;
    const pastedFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && ACCEPTED_IMAGE_TYPES.has(item.type))
      .map((item, index) => {
        const file = item.getAsFile();
        if (!file) return null;
        return new File([file], clipboardImageName(file.type, index), {
          type: file.type,
          lastModified: Date.now(),
        });
      })
      .filter((file): file is File => file !== null);
    if (pastedFiles.length === 0) return;
    addImages(pastedFiles);
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target) {
        URL.revokeObjectURL(target.url);
        objectUrls.current.delete(target.url);
      }
      return current.filter((image) => image.id !== id);
    });
  };

  const toggleToolOpen = (toolId: string) => {
    setItems((current) =>
      current.map((item) => {
        if (item.kind !== "assistant_turn") return item;
        return {
          ...item,
          parts: item.parts.map((part) =>
            part.type === "tool" && part.id === toolId
              ? { ...part, open: !part.open }
              : part,
          ),
        };
      }),
    );
  };

  const consumeEvent = (event: StreamEvent) => {
    if (event.type === "assistant_delta") {
      const delta = String(event.text ?? "");
      if (!delta) return;
      setItems((current) => {
        const ensured = ensureAssistantTurn(current, activeTurnIdRef);
        return patchAssistantTurn(ensured.items, ensured.turnId, (parts) => {
          const last = parts[parts.length - 1];
          if (last && last.type === "text" && last.streaming) {
            return [
              ...parts.slice(0, -1),
              { ...last, content: `${last.content}${delta}` },
            ];
          }
          return [
            ...parts,
            { type: "text", id: makeId(), content: delta, streaming: true },
          ];
        });
      });
      return;
    }
    if (event.type === "assistant") {
      const content = String(event.content ?? "");
      setItems((current) => {
        const ensured = ensureAssistantTurn(current, activeTurnIdRef);
        if (!content.trim()) return ensured.items;
        return patchAssistantTurn(ensured.items, ensured.turnId, (parts) => {
          const last = parts[parts.length - 1];
          if (last && last.type === "text" && last.streaming) {
            return [
              ...parts.slice(0, -1),
              { ...last, content, streaming: false },
            ];
          }
          if (last && last.type === "text" && !last.streaming) {
            // Non-stream multi-step assistant messages in one turn.
            if (last.content === content) return parts;
            return [
              ...parts.slice(0, -1),
              { ...last, content: `${last.content}\n\n${content}` },
            ];
          }
          return [
            ...parts,
            { type: "text", id: makeId(), content, streaming: false },
          ];
        });
      });
      return;
    }
    if (event.type === "tool_start") {
      const toolId = String(event.id);
      const details = formatToolDetails(event.arguments);
      setItems((current) => {
        const ensured = ensureAssistantTurn(current, activeTurnIdRef);
        return patchAssistantTurn(ensured.items, ensured.turnId, (parts) => [
          ...parts,
          {
            type: "tool",
            id: toolId,
            name: String(event.name),
            status: "running",
            details,
            open: false,
          },
        ]);
      });
      return;
    }
    if (event.type === "tool_end") {
      const toolId = String(event.id);
      const preview = String(event.preview ?? "");
      const isError = event.isError === true;
      setItems((current) =>
        current.map((item) => {
          if (item.kind !== "assistant_turn") return item;
          return {
            ...item,
            parts: item.parts.map((part) =>
              part.type === "tool" && part.id === toolId
                ? {
                    ...part,
                    status: isError ? "error" : "done",
                    preview,
                    open: false,
                  }
                : part,
            ),
          };
        }),
      );
      return;
    }
    if (event.type === "aborted") {
      setItems((current) => {
        const ensured = ensureAssistantTurn(current, activeTurnIdRef);
        return ensured.items.map((item) => {
          if (item.kind !== "assistant_turn" || item.id !== ensured.turnId) return item;
          const parts = item.parts.map((part) => {
            if (part.type === "text" && part.streaming) {
              return { ...part, streaming: false };
            }
            if (part.type === "tool" && part.status === "running") {
              return {
                ...part,
                status: "error" as const,
                preview: "已停止",
              };
            }
            return part;
          });
          const hasVisibleText = parts.some(
            (part) => part.type === "text" && part.content.trim().length > 0,
          );
          if (!hasVisibleText) {
            parts.push({
              type: "text",
              id: makeId(),
              content: "已停止生成",
              streaming: false,
            });
          }
          return { ...item, parts };
        });
      });
      return;
    }
    if (event.type === "error") {
      setItems((current) => [
        ...current,
        {
          id: makeId(),
          kind: "error",
          content: String(event.message),
          retryable: event.retryable === true,
        },
      ]);
      return;
    }
    if (event.type === "file_ready") {
      setItems((current) => [
        ...current,
        {
          id: makeId(),
          kind: "file",
          name: String(event.name ?? "download"),
          size: Number(event.size ?? 0),
          downloadUrl: String(event.downloadUrl ?? ""),
        },
      ]);
      return;
    }
    if (event.type === "permission_required") {
      setItems((current) => [
        ...current,
        {
          id: makeId(),
          kind: "permission",
          requestId: String(event.requestId ?? ""),
          tool: String(event.tool ?? "tool"),
          risk: event.risk === "high" ? "high" : "medium",
          status: "pending",
        },
      ]);
    }
  };

  const resolvePermission = async (itemId: string, requestId: string, decision: "allow" | "deny") => {
    if (!sessionId) return;
    setItems((current) => current.map((item) =>
      item.kind === "permission" && item.id === itemId ? { ...item, status: decision } : item,
    ));
    const response = await fetch(`/api/sessions/${sessionId}/permissions/${requestId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (!response.ok) setError(await readError(response));
  };

  const stopGeneration = () => {
    abortControllerRef.current?.abort();
    setPendingQueue([]);
  };

  const sendMessage = async (draftOverride?: Draft, isRetry = false) => {

    const draft = draftOverride ?? { text: prompt, images, documents, referencedPaths };
    const text = draft.text.trim();
    if (
      !config ||
      !sessionId ||
      (!text && draft.images.length === 0 && draft.documents.length === 0 && draft.referencedPaths.length === 0)
    ) {
      return;
    }

    const displayTextForQueue =
      text || (draft.referencedPaths.length > 0 ? "请阅读引用的文件并说明要点" : "分析图片");

    // If already busy, enqueue the message and show it in the timeline immediately
    if (busy) {
      const queuedDraft: Draft = {
        text,
        images: draft.images,
        documents: draft.documents,
        referencedPaths: draft.referencedPaths,
      };
      setPendingQueue((q) => [...q, queuedDraft]);
      setItems((current) => [
        ...current,
        {
          id: makeId(),
          kind: "user",
          content: displayTextForQueue,
          images: draft.images.map((image) => ({ name: image.file.name, url: image.url })),
          documents: draft.documents.map((document) => ({ name: document.file.name, size: document.file.size })),
          referencedPaths: draft.referencedPaths,
        },
      ]);
      setPrompt("");
      setImages([]);
      setReferencedPaths([]);
      return;
    }

    setBusy(true);
    setError(null);
    activeTurnIdRef.current = null;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const outgoingImages = draft.images;
    const outgoingDocuments = draft.documents;
    const outgoingRefs = draft.referencedPaths;
    setRetryDraft({ text, images: outgoingImages, documents: outgoingDocuments, referencedPaths: outgoingRefs });
    const displayText =
      text || (outgoingRefs.length > 0 ? "请阅读引用的文件并说明要点" : "分析图片");
    if (!isRetry) {
      setItems((current) => [
        ...current,
        {
          id: makeId(),
          kind: "user",
          content: displayText,
          images: outgoingImages.map((image) => ({
            name: image.file.name,
            url: image.url,
          })),
          documents: outgoingDocuments.map((document) => ({
            name: document.file.name,
            size: document.file.size,
          })),
          referencedPaths: outgoingRefs,
        },
      ]);
      setPrompt("");
      setImages([]);
      setReferencedPaths([]);
    }

    try {
      const form = new FormData();
      form.append("prompt", text);
      form.append("referencedPaths", JSON.stringify(outgoingRefs));
      for (const image of outgoingImages) form.append("images", image.file);
      for (const document of outgoingDocuments) form.append("documents", document.file);
      let activeSessionId = sessionId;
      let response = await fetch(`/api/sessions/${activeSessionId}/messages`, {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (response.status === 404) {
        activeSessionId = await requestSession();
        setSessionId(activeSessionId);
        response = await fetch(`/api/sessions/${activeSessionId}/messages`, {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
      }
      if (!response.ok) throw new Error(await readError(response));
      if (!response.body) throw new Error("Empty response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = JSON.parse(trimmed) as StreamEvent;
          if (event.type !== "user") consumeEvent(event);
        }
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer.trim()) as StreamEvent;
        if (event.type !== "user") consumeEvent(event);
      }
      setRetryDraft(null);
    } catch (err) {
      const aborted =
        (err instanceof Error && err.name === "AbortError") ||
        (typeof err === "object" &&
          err !== null &&
          "name" in err &&
          String((err as { name: unknown }).name) === "AbortError");
      if (aborted) {
        setItems((current) => {
          const ensured = ensureAssistantTurn(current, activeTurnIdRef);
          return ensured.items.map((item) => {
            if (item.kind !== "assistant_turn" || item.id !== ensured.turnId) return item;
            const parts = item.parts.map((part) =>
              part.type === "text" && part.streaming
                ? { ...part, streaming: false }
                : part.type === "tool" && part.status === "running"
                  ? { ...part, status: "error" as const, preview: "已停止" }
                  : part,
            );
            const hasVisibleText = parts.some(
              (part) => part.type === "text" && part.content.trim().length > 0,
            );
            if (!hasVisibleText) {
              parts.push({
                type: "text",
                id: makeId(),
                content: "已停止生成",
                streaming: false,
              });
            }
            return { ...item, parts };
          });
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setItems((current) => [
          ...current,
          { id: makeId(), kind: "error", content: message, retryable: true },
        ]);
      }
    } finally {
      abortControllerRef.current = null;
      setBusy(false);
      // Drain the queue: automatically send the next pending message
      setPendingQueue((q) => {
        const [next, ...rest] = q;
        if (next) {
          // Defer by one frame so React flushes busy=false before sendMessage checks it
          setTimeout(() => void sendMessage(next, false), 0);
        }
        return rest;
      });
    }
  };

  const retryLast = () => {
    if (!retryDraft || busy) return;
    void sendMessage(retryDraft, true);
  };

  // ── Model picker logic ─────────────────────────────────────────────────────

  const displayModel = activeModel || config?.model || "-";
  const displayContextWindow = activeContextWindow || contextWindow;

  const openModelPicker = async () => {
    if (busy) return;
    setModelPickerOpen(true);
    setModelSearch("");
    setModelsLoading(true);
    try {
      const response = await fetch("/api/models");
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as { models: ModelInfo[]; defaultModel: string };
      setAvailableModels(data.models);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setModelsLoading(false);
      setTimeout(() => modelSearchRef.current?.focus(), 50);
    }
  };

  const switchModel = async (model: ModelInfo) => {
    if (!sessionId || busy) return;
    setModelPickerOpen(false);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.qualifiedId }),
      });
      if (!response.ok) throw new Error(await readError(response));
      const data = (await response.json()) as {
        model: string;
        qualifiedId: string;
        contextWindow: number;
      };
      setActiveModel(data.model);
      setActiveContextWindow(data.contextWindow);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  // Close model picker when clicking outside
  useEffect(() => {
    if (!modelPickerOpen) return;
    const handler = (event: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(event.target as Node)) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelPickerOpen]);

  // Reset activeModel when session resets
  useEffect(() => {
    setActiveModel(null);
    setActiveContextWindow(0);
  }, [sessionId]);

  const filteredModels = useMemo(() => {
    if (!modelSearch.trim()) return availableModels;
    const terms = modelSearch.toLowerCase().split(/\s+/);
    return availableModels.filter((model) => {
      const hay = `${model.provider}/${model.id} ${model.name}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }, [availableModels, modelSearch]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Bot size={20} />
          </div>
          <div>
            <strong>Mini Agent</strong>
            <span>Local workspace</span>
          </div>
        </div>

        <button className="new-chat" onClick={resetSession} disabled={busy}>
          <MessageSquarePlus size={16} />
          新会话
        </button>


        <div className="workspace-tree-panel">
          <div className="section-label">
            <Folder size={13} />
            工作区文件
          </div>
          <div className="workspace-tree">
            {treeLoading && (
              <div className="tree-status">
                <LoaderCircle className="spin" size={14} />
                加载中
              </div>
            )}
            {treeError && !treeLoading && (
              <div className="tree-status error">
                <span>{treeError}</span>
                <button type="button" onClick={() => void loadRootTree()}>
                  重试
                </button>
              </div>
            )}
            {!treeLoading && !treeError && tree.length === 0 && (
              <div className="tree-status">空工作区</div>
            )}
            {!treeLoading && tree.length > 0 && (
              <TreeRows
                nodes={tree}
                depth={0}
                selected={selectedSet}
                onToggleDir={(node) => void toggleDir(node)}
                onToggleFile={toggleReferencedPath}
              />
            )}
          </div>
        </div>

        <div className="connection-state">
          <span className={`status-dot ${config ? "online" : ""}`} />
          {config ? "服务已连接" : "连接中"}
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div>
            <h1>会话</h1>
            <span>{workspaceLabel}</span>
          </div>
          <div className="header-status">
            <span className={`status-dot ${sessionId ? (busy ? "working" : "online") : ""}`} />
            {busy ? "处理中" : sessionId ? "就绪" : "未连接"}
          </div>
        </header>

        <div className="conversation" ref={scrollRef}>
          {items.length === 0 && (
            <div className="empty-state">
              <div className="empty-mark">
                <Bot size={22} />
              </div>
              <h2>开始本地代码对话</h2>
              <p>在左侧点选文件引用路径，或直接提问让 agent 用 read 工具读取工作区。</p>
            </div>
          )}

          {items.map((item) => {
            if (item.kind === "permission") {
              return (
                <article className={`permission-card ${item.risk}`} key={item.id}>
                  <div>
                    <strong>工具需要授权：{item.tool}</strong>
                    <span>{item.risk === "high" ? "高风险操作" : "会修改工作区或生成文件"}</span>
                  </div>
                  {item.status === "pending" ? (
                    <div className="permission-actions">
                      <button onClick={() => void resolvePermission(item.id, item.requestId, "deny")}>拒绝</button>
                      <button className="allow" onClick={() => void resolvePermission(item.id, item.requestId, "allow")}>允许</button>
                    </div>
                  ) : (
                    <span className="permission-decision">{item.status === "allow" ? "已允许" : "已拒绝"}</span>
                  )}
                </article>
              );
            }
            if (item.kind === "file") {
              return (
                <article className="file-ready-card" key={item.id}>
                  <FileText size={18} />
                  <div>
                    <strong>{item.name}</strong>
                    <span>{Math.ceil(item.size / 1024)}KB，可下载</span>
                  </div>
                  <a href={item.downloadUrl} download={item.name} title="下载文件">
                    <Download size={17} />
                  </a>
                </article>
              );
            }
            if (item.kind === "user") {
              return (
                <article className="message user" key={item.id}>
                  <div className="message-avatar">
                    <User size={16} />
                  </div>
                  <div className="message-body">
                    {item.referencedPaths && item.referencedPaths.length > 0 && (
                      <div className="message-refs">
                        {item.referencedPaths.map((pathValue) => (
                          <span className="ref-chip" key={pathValue}>
                            <FileCode2 size={12} />
                            {pathValue}
                          </span>
                        ))}
                      </div>
                    )}
                    {item.images && item.images.length > 0 && (
                      <div className="message-images">
                        {item.images.map((image) => (
                          <figure key={image.url}>
                            <img src={image.url} alt={image.name} />
                            <figcaption>{image.name}</figcaption>
                          </figure>
                        ))}
                      </div>
                    )}
                    {item.documents && item.documents.length > 0 && (
                      <div className="message-documents">
                        {item.documents.map((document) => (
                          <span className="document-chip" key={document.name}>
                            <FileText size={13} />
                            {document.name}
                            <small>{Math.ceil(document.size / 1024)}KB</small>
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="markdown">
                      <Markdown rehypePlugins={[rehypeSanitize]}>{item.content}</Markdown>
                    </div>
                  </div>
                </article>
              );
            }
            if (item.kind === "assistant_turn") {
              const blocks: Array<
                | { type: "text"; part: TextPart }
                | { type: "tools"; tools: ToolPart[]; key: string }
              > = [];
              for (const part of item.parts) {
                if (part.type === "text") {
                  blocks.push({ type: "text", part });
                  continue;
                }
                const last = blocks[blocks.length - 1];
                if (last && last.type === "tools") {
                  last.tools.push(part);
                } else {
                  blocks.push({ type: "tools", tools: [part], key: part.id });
                }
              }
              const hasRunning = item.parts.some(
                (part) => part.type === "tool" && part.status === "running",
              );
              return (
                <article className="message assistant" key={item.id}>
                  <div className="message-avatar">
                    <Bot size={16} />
                  </div>
                  <div className="message-body">
                    {item.parts.length === 0 && (
                      <div className="assistant-thinking">
                        <LoaderCircle className="spin" size={15} />
                        思考中…
                      </div>
                    )}
                    {blocks.map((block) =>
                      block.type === "text" ? (
                        <div className={`markdown assistant-text${block.part.streaming ? " streaming" : ""}`} key={block.part.id}>
                          <Markdown rehypePlugins={[rehypeSanitize]}>
                            {block.part.content}
                          </Markdown>
                          {block.part.streaming ? <span className="stream-caret" /> : null}
                        </div>
                      ) : (
                        <ToolsGroup
                          key={block.key}
                          tools={block.tools}
                          onToggle={toggleToolOpen}
                        />
                      ),
                    )}
                    {hasRunning && (
                      <div className="assistant-thinking subtle">
                        <LoaderCircle className="spin" size={14} />
                        工具执行中
                      </div>
                    )}
                  </div>
                </article>
              );
            }

            return (
              <div className="error-row" key={item.id}>
                <AlertCircle size={17} />
                <span>{item.content}</span>
                {item.retryable && (
                  <button
                    className="retry-button"
                    onClick={retryLast}
                    disabled={busy || !retryDraft}
                    title="重试"
                  >
                    <RotateCcw size={14} />
                  </button>
                )}
              </div>
            );
          })}

          {busy && !hasAssistantAfterLastUser(items) && (
            <div className="thinking-row">
              <LoaderCircle className="spin" size={17} />
              Agent 正在处理
            </div>
          )}
        </div>

        <div className="composer-area">
          {error && (
            <div className="composer-error">
              <AlertCircle size={15} />
              <span>{error}</span>
              <button onClick={() => setError(null)} title="关闭错误"><X size={15} /></button>
            </div>
          )}

          {referencedPaths.length > 0 && (
            <div className="pending-refs">
              {referencedPaths.map((pathValue) => (
                <span className="ref-chip editable" key={pathValue}>
                  <FileCode2 size={12} />
                  {pathValue}
                  <button
                    type="button"
                    onClick={() => toggleReferencedPath(pathValue)}
                    title={`移除 ${pathValue}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {images.length > 0 && (
            <div className="pending-images">
              {images.map((image) => (
                <div className="pending-image" key={image.id}>
                  <img src={image.url} alt={image.file.name} />
                  <span>{image.file.name}</span>
                  <button onClick={() => removeImage(image.id)} title={`移除 ${image.file.name}`}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {documents.length > 0 && (
            <div className="pending-documents">
              {documents.map((document) => (
                <div className="pending-document" key={document.id}>
                  <FileText size={16} />
                  <span>{document.file.name}</span>
                  <button onClick={() => removeDocument(document.id)} title={`移除 ${document.file.name}`}>
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="composer">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              onPaste={handlePaste}
              placeholder={busy ? "输入消息（当前响应结束后自动发送）" : "输入消息，或从左侧引用文件"}
              rows={1}
              disabled={!config || !sessionId}
            />
            <div className="composer-actions">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                hidden
                onChange={(event) => addImages(event.target.files ? Array.from(event.target.files) : [])}
              />
              <button
                className="icon-button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!config || !sessionId || images.length >= (config?.maxImages ?? 0)}
                title="添加图片"
              >
                <ImagePlus size={19} />
              </button>
              <input
                ref={documentInputRef}
                type="file"
                accept="application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx"
                multiple
                hidden
                onChange={(event) => addDocuments(event.target.files ? Array.from(event.target.files) : [])}
              />
              <button
                className="icon-button"
                onClick={() => documentInputRef.current?.click()}
                disabled={!config || !sessionId || images.length + documents.length >= (config?.maxAttachments ?? 0)}
                title="添加 PDF 或 Word 文档"
              >
                <FileText size={19} />
              </button>
              {pendingQueue.length > 0 && (
                <span className="queue-badge" title={`${pendingQueue.length} 条消息等待发送`}>
                  {pendingQueue.length}
                </span>
              )}
              <button
                className={`send-button${busy && !prompt.trim() && images.length === 0 && documents.length === 0 && referencedPaths.length === 0 ? " stop" : ""}`}
                onClick={() => {
                  if (busy && !prompt.trim() && images.length === 0 && documents.length === 0 && referencedPaths.length === 0) {
                    stopGeneration();
                  } else {
                    void sendMessage();
                  }
                }}
                disabled={
                  !config ||
                  !sessionId ||
                  (!busy &&
                    !prompt.trim() &&
                    images.length === 0 &&
                    documents.length === 0 &&
                    referencedPaths.length === 0)
                }
                title={busy && !prompt.trim() && images.length === 0 && documents.length === 0 && referencedPaths.length === 0 ? "停止" : busy ? "加入队列" : "发送"}
              >
                {busy && !prompt.trim() && images.length === 0 && documents.length === 0 && referencedPaths.length === 0
                  ? <Square size={16} />
                  : <Send size={18} />}
              </button>
            </div>
          </div>
          <div className="model-picker-wrapper" ref={modelPickerRef}>
            <button
              type="button"
              className={`context-meter clickable${modelPickerOpen ? " open" : ""}`}
              onClick={() => modelPickerOpen ? setModelPickerOpen(false) : void openModelPicker()}
              disabled={busy}
              title="点击切换模型"
            >
              <span className="model-name">
                <Zap size={12} />
                {displayModel}
              </span>
              <span>
                ~{formatTokenCount(usedTokens)}
                {displayContextWindow > 0 ? ` / ${formatTokenCount(displayContextWindow)}` : ""}
              </span>
              <ChevronDown size={13} className={modelPickerOpen ? "flip" : ""} />
            </button>
            {modelPickerOpen && (
              <div className="model-picker-dropdown">
                <div className="model-picker-search">
                  <Search size={14} />
                  <input
                    ref={modelSearchRef}
                    type="text"
                    value={modelSearch}
                    onChange={(event) => setModelSearch(event.target.value)}
                    placeholder="搜索模型…"
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setModelPickerOpen(false);
                      if (event.key === "Enter" && filteredModels.length > 0) {
                        void switchModel(filteredModels[0]!);
                      }
                    }}
                  />
                </div>
                <div className="model-picker-list">
                  {modelsLoading && (
                    <div className="model-picker-status">
                      <LoaderCircle className="spin" size={14} />
                      加载模型列表…
                    </div>
                  )}
                  {!modelsLoading && filteredModels.length === 0 && (
                    <div className="model-picker-status">
                      {modelSearch ? "没有匹配的模型" : "没有可用的模型"}
                    </div>
                  )}
                  {!modelsLoading && filteredModels.map((model) => {
                    const isActive = model.id === displayModel || model.qualifiedId === displayModel;
                    return (
                      <button
                        type="button"
                        key={model.qualifiedId}
                        className={`model-picker-item${isActive ? " active" : ""}`}
                        onClick={() => void switchModel(model)}
                        title={`${model.qualifiedId} · ${formatTokenCount(model.contextWindow)} context`}
                      >
                        <span className="model-picker-item-name">
                          <strong>{model.id}</strong>
                          <small>{model.provider}</small>
                        </span>
                        <span className="model-picker-item-meta">
                          {model.reasoning && <span className="model-tag">推理</span>}
                          {model.capabilities.input.includes("image") && <span className="model-tag">视觉</span>}
                          <span>{formatTokenCount(model.contextWindow)}</span>
                        </span>
                        {isActive && <Check size={14} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
