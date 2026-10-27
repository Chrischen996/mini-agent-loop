import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon.tsx";
import { api } from "../lib/api.ts";
import { ModelSelector } from "./ModelSelector.tsx";
import { CustomModelProviderManager } from "./CustomModelProviderManager.tsx";
import { useI18n } from "../lib/i18n.tsx";

type PermissionMode = "plan" | "bypass";

const SECTIONS = ["general", "models", "skills", "about"] as const;

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
  const { t, locale, setLocale } = useI18n();
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
      <nav className="settings-nav" aria-label={t("settingsSections")}>
        <h2 id="settings-title">{t("settings")}</h2>
        {SECTIONS.map((key) => <button type="button" key={key} aria-current={section === key ? "page" : undefined} className={`settings-nav__item${section === key ? " settings-nav__item--active" : ""}`} onClick={() => { setSection(key); setError(null); }}>{t(key)}</button>)}
      </nav>
      <div className="settings-content">
        <header className="settings-content__header"><h3>{t(section)}</h3><button type="button" className="icon-button" aria-label={t("closeSettings")} onClick={onClose}><Icon name="close" /></button></header>
        {section === "general" && <>
        <section className="settings-section" aria-labelledby="appearance-title">
          <h4 id="appearance-title">{t("appearance")}</h4>
          <div className="settings-row"><div><strong>{t("theme")}</strong></div>
            <div className="segmented-control" role="group" aria-label={t("theme")}>
              {(["system", "light", "dark"] as const).map((value) => <button type="button" key={value} aria-pressed={theme === value} className={theme === value ? "is-selected" : ""} onClick={() => onThemeChange(value)}>{t(value)}</button>)}
            </div>
          </div>
          <div className="settings-row"><div><strong>{t("language")}</strong></div>
            <div className="segmented-control" role="group" aria-label={t("language")}>
              <button type="button" aria-pressed={locale === "zh-CN"} className={locale === "zh-CN" ? "is-selected" : ""} onClick={() => setLocale("zh-CN")}>{t("chinese")}</button>
              <button type="button" aria-pressed={locale === "en-US"} className={locale === "en-US" ? "is-selected" : ""} onClick={() => setLocale("en-US")}>{t("english")}</button>
            </div>
          </div>
        </section>
        <section className="settings-section" aria-labelledby="permissions-title">
          <h4 id="permissions-title">{t("currentSession")}</h4>
          <div className="settings-row"><div><strong>{t("permissionMode")}</strong></div>
            <div className="segmented-control" role="group" aria-label={t("permissionMode")}>
              <button type="button" disabled={!sessionId || savingPermission} aria-pressed={permissionMode === "plan"} className={permissionMode === "plan" ? "is-selected" : ""} onClick={() => void changePermission("plan")}>{t("plan")}</button>
              <button type="button" disabled={!sessionId || savingPermission} aria-pressed={permissionMode === "bypass"} className={permissionMode === "bypass" ? "is-selected" : ""} onClick={() => void changePermission("bypass")}>{t("bypass")}</button>
            </div>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </section>
        </>}
        {section === "models" && <>
          <section className="settings-section settings-models"><h4>{t("currentSessionModel")}</h4><ModelSelector sessionId={sessionId} currentModel={model} currentThinkingLevel={thinkingLevel} disabled={savingPermission} onModelChange={onModelChange} /></section>
          <CustomModelProviderManager onModelChange={onModelChange} />
        </>}
        {section === "skills" && <section className="settings-section settings-skills"><h4>{t("sessionSkills")}</h4>{!sessionId ? <p className="muted">{t("createSessionFirst")}</p> : skills ? skills.available.map((skill) => <label className="settings-skill" key={skill.name}><input type="checkbox" checked={skills.active.includes(skill.name)} disabled={Boolean(savingSkill)} onChange={async (event) => { const enabled = event.target.checked; setSavingSkill(skill.name); setError(null); try { const updated = await api.updateSessionSkills(sessionId, enabled ? { add: [skill.name] } : { remove: [skill.name] }); setSkills(updated); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setSavingSkill(null); } }} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>) : <p className="muted">{t("loading")}</p>}</section>}
        {section === "about" && <section className="settings-section settings-about"><h4>{t("miniAgentLoop")}</h4><p>{t("webWorkbench")}</p></section>}
        {error && section !== "general" && <p className="error" role="alert">{error}</p>}
      </div>
    </section>
  </div>;
}
