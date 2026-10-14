import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { api } from "../lib/api.ts";
import { ModelSelector } from "./ModelSelector.tsx";

type PermissionMode = "plan" | "bypass";

export function SettingsDialog({ open, onClose, theme, onThemeChange, sessionId, permissionMode, model, thinkingLevel, onModelChange, onPermissionChange }: {
  open: boolean;
  onClose: () => void;
  theme: string;
  onThemeChange: (theme: string) => void;
  sessionId: string | null;
  permissionMode: string;
  model: string | null;
  thinkingLevel: string | null;
  onModelChange: () => void;
  onPermissionChange: (mode: PermissionMode) => Promise<void>;
}) {
  const dialog = useRef<HTMLDivElement | null>(null);
  const [savingPermission, setSavingPermission] = useState(false);
  const [section, setSection] = useState<"general" | "models" | "skills" | "about">("general");
  const [skills, setSkills] = useState<{ available: Array<{ name: string; description: string }>; active: string[]; missing: string[] } | null>(null);
  const [savingSkill, setSavingSkill] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || section !== "skills" || !sessionId) return;
    let cancelled = false;
    void api.getSessionSkills(sessionId).then((result) => { if (!cancelled) setSkills(result); }).catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [open, section, sessionId]);

  if (!open) return null;
  const changePermission = async (mode: PermissionMode) => {
    if (!sessionId || savingPermission || mode === permissionMode) return;
    setSavingPermission(true);
    setError(null);
    try { await onPermissionChange(mode); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSavingPermission(false); }
  };

  return <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
      <nav className="settings-nav" aria-label="Settings sections">
        <h2 id="settings-title">Settings</h2>
        {([["general", "General"], ["models", "Models"], ["skills", "Skills"], ["about", "About"]] as const).map(([key, label]) => <button type="button" key={key} aria-current={section === key ? "page" : undefined} className={`settings-nav__item${section === key ? " settings-nav__item--active" : ""}`} onClick={() => { setSection(key); setError(null); }}>{label}</button>)}
      </nav>
      <div className="settings-content">
        <header className="settings-content__header"><h3>{section === "general" ? "General" : section === "models" ? "Models" : section === "skills" ? "Skills" : "About"}</h3><button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}><Icon name="close" /></button></header>
        {section === "general" && <>
        <section className="settings-section" aria-labelledby="appearance-title">
          <h4 id="appearance-title">Appearance</h4>
          <div className="settings-row"><div><strong>Theme</strong></div>
            <div className="segmented-control" role="group" aria-label="Theme">
              {[ ["system", "System"], ["light", "Light"], ["dark", "Dark"] ].map(([value, label]) => <button type="button" key={value} aria-pressed={theme === value} className={theme === value ? "is-selected" : ""} onClick={() => onThemeChange(value)}>{label}</button>)}
            </div>
          </div>
        </section>
        <section className="settings-section" aria-labelledby="permissions-title">
          <h4 id="permissions-title">Current session</h4>
          <div className="settings-row"><div><strong>Permission mode</strong></div>
            <div className="segmented-control" role="group" aria-label="Permission mode">
              <button type="button" disabled={!sessionId || savingPermission} aria-pressed={permissionMode === "plan"} className={permissionMode === "plan" ? "is-selected" : ""} onClick={() => void changePermission("plan")}>Plan</button>
              <button type="button" disabled={!sessionId || savingPermission} aria-pressed={permissionMode === "bypass"} className={permissionMode === "bypass" ? "is-selected" : ""} onClick={() => void changePermission("bypass")}>Bypass</button>
            </div>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </section>
        </>}
        {section === "models" && <section className="settings-section settings-models"><h4>Current session model</h4><ModelSelector sessionId={sessionId} currentModel={model} currentThinkingLevel={thinkingLevel} disabled={savingPermission} onModelChange={onModelChange} /></section>}
        {section === "skills" && <section className="settings-section settings-skills"><h4>Session skills</h4>{!sessionId ? <p className="muted">Create a session to manage skills.</p> : skills ? skills.available.map((skill) => <label className="settings-skill" key={skill.name}><input type="checkbox" checked={skills.active.includes(skill.name)} disabled={Boolean(savingSkill)} onChange={async (event) => { const enabled = event.target.checked; setSavingSkill(skill.name); setError(null); try { const updated = await api.updateSessionSkills(sessionId, enabled ? { add: [skill.name] } : { remove: [skill.name] }); setSkills(updated); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setSavingSkill(null); } }} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>) : <p className="muted">Loading…</p>}</section>}
        {section === "about" && <section className="settings-section settings-about"><h4>Mini Agent Loop</h4><p>Web workspace</p></section>}
        {error && section !== "general" && <p className="error" role="alert">{error}</p>}
      </div>
    </section>
  </div>;
}
