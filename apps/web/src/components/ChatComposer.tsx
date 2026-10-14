import { Icon } from "./Icon.tsx";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";

const MAX_FILES = 5;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx"]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function fileKind(file: File): "image" | "document" | null {
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  if (IMAGE_MIME_TYPES.has(file.type) || IMAGE_EXTENSIONS.has(extension)) return "image";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return null;
}

function formatSize(size: number): string {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function ChatComposer({
  disabled,
  streaming,
  onSend,
  onStop,
  controls,
  onModelCommand,
}: {
  disabled: boolean;
  streaming: boolean;
  onSend: (prompt: string, files: File[]) => void;
  onStop: () => void;
  controls?: ReactNode;
  onModelCommand?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const addMenu = useRef<HTMLDivElement | null>(null);
  const addButton = useRef<HTMLButtonElement | null>(null);
  const canSend = !disabled && !streaming && (draft.trim().length > 0 || files.length > 0);

  useEffect(() => {
    if (!addMenuOpen) return;
    const closeOnOutsideClick = (event: PointerEvent): void => {
      if (!addMenu.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [addMenuOpen]);

  const addFiles = (incoming: FileList | File[]): void => {
    setFileError(null);
    const accepted: File[] = [];
    for (const file of Array.from(incoming)) {
      if (!fileKind(file)) {
        setFileError(`${file.name}: use an image, PDF, or DOCX file.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        setFileError(`${file.name}: files must be 4 MB or smaller.`);
        continue;
      }
      accepted.push(file);
    }
    const remaining = MAX_FILES - files.length;
    if (accepted.length > remaining) setFileError(`Attach up to ${MAX_FILES} files per message.`);
    setFiles([...files, ...accepted.slice(0, remaining)]);
  };

  const submit = (): void => {
    if (!canSend) return;
    const prompt = draft.trim();
    if (/^\/model$/i.test(prompt) && onModelCommand) {
      onModelCommand();
      setDraft("");
      if (inputRef.current) inputRef.current.style.height = "";
      return;
    }
    onSend(prompt, files);
    setDraft("");
    if (inputRef.current) inputRef.current.style.height = "";
    setFiles([]);
    setFileError(null);
  };

  const resizeInput = (input: HTMLTextAreaElement): void => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 336)}px`;
  };

  const handleDrop = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault();
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pastedFiles = Array.from(event.clipboardData.files);
    if (pastedFiles.length) addFiles(pastedFiles);
  };

  return (
    <footer className="composer" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
      <input ref={fileInput} className="composer__file-input" type="file" accept="image/png,image/jpeg,image/gif,image/webp,.png,.jpg,.jpeg,.gif,.webp,.pdf,.docx" multiple aria-label="Choose files to attach" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
      {files.length > 0 && <div className="composer__attachments" aria-label="Attached files">
        {files.map((file, index) => <div className="composer__attachment" key={`${file.name}-${file.lastModified}-${index}`}>
          <Icon name={fileKind(file) === "image" ? "image" : "file"} width={16} height={16} />
          <span className="composer__attachment-name" title={file.name}>{file.name}</span>
          <span className="composer__attachment-size">{formatSize(file.size)}</span>
          <button type="button" className="icon-button" aria-label={`Remove ${file.name}`} title={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Icon name="close" width={14} height={14} /></button>
        </div>)}
      </div>}
      {fileError && <p className="composer__file-error" role="alert">{fileError}</p>}
      <textarea
        ref={inputRef}
        className="composer__input"
        aria-label="Message"
        placeholder="Ask anything, or describe a task…"
        value={draft}
        rows={1}
        disabled={disabled}
        onChange={(event) => { setDraft(event.target.value); resizeInput(event.currentTarget); }}
        onPaste={handlePaste}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer__actions">
        <div className="composer__add-menu" ref={addMenu} onKeyDown={(event) => {
          if (event.key === "Escape" && addMenuOpen) {
            event.preventDefault();
            setAddMenuOpen(false);
            addButton.current?.focus();
          }
        }}>
          <button ref={addButton} type="button" className="icon-button composer__add" aria-label="Add to message" title="Add to message" aria-haspopup="menu" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((open) => !open)} disabled={disabled || streaming || files.length >= MAX_FILES}>
            <Icon name="plus" />
          </button>
          {addMenuOpen && <div className="composer__menu" role="menu" aria-label="Add to message">
            <button type="button" role="menuitem" className="composer__menu-item" onClick={() => { setAddMenuOpen(false); fileInput.current?.click(); }}>
              <Icon name="file" width={16} height={16} />
              <span>File</span>
            </button>
          </div>}
        </div>
        <span className="composer__hint">Enter to send · Shift+Enter for a new line</span>
        <div className="composer__controls">{controls}
        {streaming ? (
          <button type="button" className="composer__send composer__send--stop" aria-label="Stop response" title="Stop response" onClick={onStop}>
            <Icon name="stop" />
          </button>
        ) : (
          <button type="button" className="composer__send" aria-label="Send message" title="Send message" onClick={submit} disabled={!canSend}>
            <Icon name="send" />
          </button>
        )}
        </div>
      </div>
    </footer>
  );
}
