import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  ImagePlus,
  LoaderCircle,
  MessageSquarePlus,
  RotateCcw,
  Send,
  Settings2,
  User,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

type AppConfig = {
  model: string;
  modelVision: boolean;
  visionPreprocessor: "enabled" | "disabled";
  workspace: string;
  workspaceLabel?: string;
  maxImages: number;
  maxImageBytes: number;
};

type UserMessageItem = {
  id: string;
  kind: "user";
  content: string;
  images?: Array<{ name: string; url: string }>;
  referencedPaths?: string[];
};

type TextPart = {
  type: "text";
  id: string;
  content: string;
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

type TimelineItem = UserMessageItem | AssistantTurnItem | ErrorItem;

type PendingImage = {
  id: string;
  file: File;
  url: string;
};

type Draft = {
  text: string;
  images: PendingImage[];
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

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

function hasAssistantAfterLastUser(items: TimelineItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.kind === "assistant_turn") return true;
    if (items[i]?.kind === "user") return false;
  }
  return false;
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
  const summary =
    part.status === "running"
      ? part.details || "执行中…"
      : part.preview || part.details || "完成";
  const canExpand = part.status !== "running" && Boolean(part.preview);
  return (
    <div className={`tool-card ${part.status}`}>
      <button
        type="button"
        className="tool-card-header"
        onClick={() => {
          if (canExpand) onToggle(part.id);
        }}
        disabled={!canExpand}
      >
        <span className="tool-card-status">
          {part.status === "running" ? (
            <LoaderCircle className="spin" size={14} />
          ) : part.status === "error" ? (
            <AlertCircle size={14} />
          ) : (
            <Check size={14} />
          )}
        </span>
        <Wrench size={13} />
        <strong>{part.name}</strong>
        <span className="tool-card-summary">{part.details || ""}</span>
        {canExpand ? (
          part.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />
        ) : null}
      </button>
      {part.status === "running" && (
        <div className="tool-card-loading">
          <span className="tool-card-loading-bar" />
          正在读取…
        </div>
      )}
      {part.open && part.preview && (
        <pre className="tool-card-preview">{part.preview}</pre>
      )}
      {!part.open && part.status !== "running" && summary && (
        <div className="tool-card-snippet">{summary}</div>
      )}
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
  const [referencedPaths, setReferencedPaths] = useState<string[]>([]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryDraft, setRetryDraft] = useState<Draft | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const objectUrls = useRef(new Set<string>());
  const activeTurnIdRef = useRef<string | null>(null);

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
      for (const url of objectUrls.current) URL.revokeObjectURL(url);
      objectUrls.current.clear();
      setImages([]);
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
    if (event.type === "assistant") {
      const content = String(event.content ?? "").trim();
      setItems((current) => {
        const ensured = ensureAssistantTurn(current, activeTurnIdRef);
        if (!content) return ensured.items;
        return patchAssistantTurn(ensured.items, ensured.turnId, (parts) => {
          const last = parts[parts.length - 1];
          if (last && last.type === "text") {
            return [
              ...parts.slice(0, -1),
              { ...last, content: `${last.content}\n\n${content}` },
            ];
          }
          return [...parts, { type: "text", id: makeId(), content }];
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
    }
  };

  const sendMessage = async (draftOverride?: Draft, isRetry = false) => {
    const draft = draftOverride ?? { text: prompt, images, referencedPaths };
    const text = draft.text.trim();
    if (
      !ready ||
      (!text && draft.images.length === 0 && draft.referencedPaths.length === 0) ||
      !sessionId
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    activeTurnIdRef.current = null;
    const outgoingImages = draft.images;
    const outgoingRefs = draft.referencedPaths;
    setRetryDraft({ text, images: outgoingImages, referencedPaths: outgoingRefs });
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
      const response = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        body: form,
      });
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
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setItems((current) => [
        ...current,
        { id: makeId(), kind: "error", content: message, retryable: true },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const retryLast = () => {
    if (!retryDraft || busy) return;
    void sendMessage(retryDraft, true);
  };

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

        <div className="environment">
          <div className="section-label">
            <Settings2 size={13} />
            环境
          </div>
          <dl>
            <div><dt>模型</dt><dd>{config?.model ?? "-"}</dd></div>
            <div><dt>视觉</dt><dd>{visionLabel}</dd></div>
            <div><dt>空间</dt><dd>{workspaceLabel}</dd></div>
          </dl>
        </div>

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
                    <div className="markdown">
                      <Markdown rehypePlugins={[rehypeSanitize]}>{item.content}</Markdown>
                    </div>
                  </div>
                </article>
              );
            }
            if (item.kind === "assistant_turn") {
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
                    {item.parts.map((part) =>
                      part.type === "text" ? (
                        <div className="markdown assistant-text" key={part.id}>
                          <Markdown rehypePlugins={[rehypeSanitize]}>
                            {part.content}
                          </Markdown>
                        </div>
                      ) : (
                        <ToolCard
                          key={part.id}
                          part={part}
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
              placeholder="输入消息，或从左侧引用文件"
              rows={1}
              disabled={!config || busy}
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
                disabled={!ready || images.length >= (config?.maxImages ?? 0)}
                title="添加图片"
              >
                <ImagePlus size={19} />
              </button>
              <button
                className="send-button"
                onClick={() => void sendMessage()}
                disabled={
                  !ready ||
                  (!prompt.trim() && images.length === 0 && referencedPaths.length === 0)
                }
                title="发送"
              >
                {busy ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

