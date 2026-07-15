import {
  AlertCircle,
  Bot,
  Check,
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
import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

type AppConfig = {
  model: string;
  modelVision: boolean;
  visionPreprocessor: "enabled" | "disabled";
  workspace: string;
  maxImages: number;
  maxImageBytes: number;
};

type MessageItem = {
  id: string;
  kind: "message";
  role: "user" | "assistant";
  content: string;
  images?: Array<{ name: string; url: string }>;
};

type ToolItem = {
  id: string;
  kind: "tool";
  name: string;
  status: "running" | "done" | "error";
  details?: string;
  preview?: string;
};

type ErrorItem = {
  id: string;
  kind: "error";
  content: string;
  retryable?: boolean;
};

type TimelineItem = MessageItem | ToolItem | ErrorItem;

type PendingImage = {
  id: string;
  file: File;
  url: string;
};

type Draft = {
  text: string;
  images: PendingImage[];
};

type StreamEvent = {
  type: string;
  [key: string]: unknown;
};

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

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

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryDraft, setRetryDraft] = useState<Draft | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const objectUrls = useRef(new Set<string>());

  const requestSession = async (): Promise<string> => {
    const response = await fetch("/api/sessions", { method: "POST" });
    if (!response.ok) throw new Error(await readError(response));
    const data = (await response.json()) as { id: string };
    return data.id;
  };

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

    if (candidates.length > available) {
      firstError = `最多添加 ${config.maxImages} 张图片`;
    }
    if (available === 0 && candidates.length > 0) {
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
    if (!event.clipboardData.getData("text/plain")) {
      event.preventDefault();
    }
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

  const consumeEvent = (event: StreamEvent) => {
    if (event.type === "assistant") {
      const content = String(event.content ?? "").trim();
      if (content) {
        setItems((current) => [
          ...current,
          { id: makeId(), kind: "message", role: "assistant", content },
        ]);
      }
      return;
    }
    if (event.type === "tool_start") {
      setItems((current) => [
        ...current,
        {
          id: String(event.id),
          kind: "tool",
          name: String(event.name),
          status: "running",
          details: JSON.stringify(event.arguments ?? {}),
        },
      ]);
      return;
    }
    if (event.type === "tool_end") {
      setItems((current) =>
        current.map((item) =>
          item.kind === "tool" && item.id === String(event.id)
            ? {
                ...item,
                status: event.isError ? "error" : "done",
                preview: String(event.preview ?? ""),
              }
            : item,
        ),
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
    const draft = draftOverride ?? { text: prompt, images };
    const text = draft.text.trim();
    if (!ready || (!text && draft.images.length === 0) || !sessionId) return;
    setBusy(true);
    setError(null);
    const outgoingImages = draft.images;
    setRetryDraft({ text, images: outgoingImages });
    const displayText = text || "分析图片";
    if (!isRetry) {
      setItems((current) => [
        ...current,
        {
          id: makeId(),
          kind: "message",
          role: "user",
          content: displayText,
          images: outgoingImages.map((image) => ({
            name: image.file.name,
            url: image.url,
          })),
        },
      ]);
      setPrompt("");
      setImages([]);
    }

    try {
      const form = new FormData();
      form.append("prompt", text);
      for (const image of outgoingImages) form.append("images", image.file);
      const response = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) throw new Error(await readError(response));
      if (!response.body) throw new Error("Response stream is unavailable");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let streamFailed = false;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            const event = JSON.parse(line) as StreamEvent;
            streamFailed ||= event.type === "error";
            consumeEvent(event);
          }
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer) as StreamEvent;
        streamFailed ||= event.type === "error";
        consumeEvent(event);
      }
      if (!streamFailed) setRetryDraft(null);
    } catch (err) {
      setItems((current) => [
        ...current,
        {
          id: makeId(),
          kind: "error",
          content: err instanceof Error ? err.message : String(err),
          retryable: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const retryLast = () => {
    if (retryDraft && !busy) void sendMessage(retryDraft, true);
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Bot size={21} /></span>
          <div>
            <strong>Mini Agent</strong>
            <span>Local workspace</span>
          </div>
        </div>

        <button className="new-chat" onClick={resetSession} disabled={busy}>
          <MessageSquarePlus size={17} />
          新对话
        </button>

        <div className="environment">
          <div className="section-label"><Settings2 size={14} />运行环境</div>
          <dl>
            <div><dt>模型</dt><dd>{config?.model ?? "连接中"}</dd></div>
            <div><dt>视觉</dt><dd>{visionLabel}</dd></div>
            <div><dt>空间</dt><dd>{config?.workspace ?? "-"}</dd></div>
          </dl>
        </div>

        <div className="connection-state">
          <span className={`status-dot ${config ? "online" : ""}`} />
          {config ? "服务已连接" : "正在连接"}
        </div>
      </aside>

      <main className="chat-panel">
        <header className="chat-header">
          <div>
            <h1>工作区对话</h1>
            <span>{config?.model ?? "Agent"}</span>
          </div>
          <div className="header-status">
            <span className={`status-dot ${busy ? "working" : "online"}`} />
            {busy ? "处理中" : "就绪"}
          </div>
        </header>

        <div className="conversation" ref={scrollRef} aria-live="polite">
          {items.length === 0 && (
            <div className="empty-state">
              <span className="empty-mark"><Bot size={32} /></span>
              <h2>Mini Agent</h2>
              <p>{visionLabel}</p>
            </div>
          )}

          {items.map((item) => {
            if (item.kind === "message") {
              return (
                <article className={`message ${item.role}`} key={item.id}>
                  <div className="message-avatar">
                    {item.role === "user" ? <User size={16} /> : <Bot size={16} />}
                  </div>
                  <div className="message-body">
                    <div className="message-label">
                      {item.role === "user" ? "你" : "Mini Agent"}
                    </div>
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
            if (item.kind === "tool") {
              return (
                <div className={`tool-row ${item.status}`} key={item.id}>
                  <span className="tool-icon">
                    {item.status === "running" ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : item.status === "error" ? (
                      <AlertCircle size={16} />
                    ) : (
                      <Check size={16} />
                    )}
                  </span>
                  <div>
                    <strong><Wrench size={13} /> {item.name}</strong>
                    <span>{item.status === "running" ? item.details : item.preview}</span>
                  </div>
                </div>
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

          {busy && (
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
              placeholder="输入消息"
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
                disabled={!ready || (!prompt.trim() && images.length === 0)}
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
