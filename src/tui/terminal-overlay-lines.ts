import type { ExecutionPlan } from "../plan-act/types.ts";
import type { PendingPermissionState } from "./state.ts";
import type { RenderLine } from "./render-lines.ts";
import type { TerminalAutocompleteState } from "./terminal-autocomplete-controller.ts";
import { permissionRiskLabel, toolArgumentSummary } from "./claude-style.ts";
import { terminalStringWidth } from "./terminal-width.ts";
import { toolVisualName } from "./tool-lines.ts";
import { executionStepStatusToTodoStatus, todoIcon } from "./todo-format.ts";
import { SESSION_PICKER_HINT } from "./session-serialization.ts";

type PanelTone = RenderLine["tone"];

function clipPanelText(value: string, width: number): string {
  if (terminalStringWidth(value) <= width) return value;
  let result = "";
  let used = 0;
  for (const grapheme of value) {
    const next = terminalStringWidth(grapheme);
    if (used + next > Math.max(0, width - 1)) break;
    result += grapheme;
    used += next;
  }
  return `${result}…`;
}

/** Shared full-width card rows used by permission, plan, and tool panels. */
export function panelTopLine(key: string, title: string, width?: number, tone?: PanelTone): RenderLine {
  if (width === undefined) return { key, text: title, prefix: "╭─ ", style: "border", tone, bold: true };
  const safeWidth = Math.max(12, width);
  const caption = `─ ${clipPanelText(title, safeWidth - 6)} `;
  const fill = Math.max(1, safeWidth - 2 - terminalStringWidth(caption));
  return { key, text: `╭${caption}${"─".repeat(fill)}╮`, style: "border", tone, bold: true };
}

export function panelContentLine(
  key: string,
  text: string,
  style: RenderLine["style"],
  options: { width?: number; tone?: PanelTone; dim?: boolean; bold?: boolean; strikethrough?: boolean } = {},
): RenderLine {
  if (options.width === undefined) {
    return {
      key,
      text,
      prefix: "│  ",
      style,
      tone: options.tone,
      dim: options.dim,
      bold: options.bold,
      strikethrough: options.strikethrough,
    };
  }
  const safeWidth = Math.max(12, options.width);
  const payloadWidth = Math.max(1, safeWidth - 4);
  const clipped = clipPanelText(text, payloadWidth);
  const padding = " ".repeat(Math.max(0, payloadWidth - terminalStringWidth(clipped)));
  return {
    key,
    text: `${clipped}${padding} │`,
    prefix: "│ ",
    style,
    tone: options.tone,
    dim: options.dim,
    bold: options.bold,
    strikethrough: options.strikethrough,
  };
}

export function panelBottomLine(key: string, width?: number): RenderLine {
  if (width === undefined) return { key, text: "", prefix: "╰─ ", style: "border", dim: true };
  const safeWidth = Math.max(12, width);
  return { key, text: `╰${"─".repeat(safeWidth - 2)}╯`, style: "border", dim: true };
}

/** Terminal row model for the same permission card rendered by Ink. */
export function permissionPanelRenderLines(request?: PendingPermissionState, width?: number): RenderLine[] {
  if (!request) return [];
  const argument = toolArgumentSummary(request.tool, request.arguments ?? {});
  const target = argument ? ` (${argument})` : "";
  const risk = permissionRiskLabel(request.risk);
  return [
    panelTopLine("permission-top", "Permission required", width, request.risk === "high" ? "error" : "running"),
    panelContentLine("permission-title", `Claude needs permission to use ${toolVisualName(request.tool)}${target}`, "error", { width, tone: request.risk === "high" ? "error" : "running", bold: true }),
    panelContentLine("permission-risk", `Risk: ${risk}`, "muted", { width, dim: true }),
    panelContentLine("permission-question", "Do you want to proceed?", "assistant", { width }),
    panelContentLine("permission-options", "❯ Allow    Deny", "assistant", { width, tone: "running", bold: true }),
    panelContentLine("permission-keys", "A allow  ·  D/Enter deny  ·  Esc cancel", "muted", { width, dim: true }),
    panelBottomLine("permission-bottom", width),
  ];
}

/** Terminal row model for the same plan approval summary rendered by Ink. */
export function planApprovalRenderLines(plan?: ExecutionPlan, width?: number): RenderLine[] {
  if (!plan) return [];
  let high = 0;
  let medium = 0;
  for (const step of plan.steps) {
    if (step.risk === "high") high++;
    else if (step.risk === "medium") medium++;
  }
  const risks = [`${plan.steps.length} steps`, ...(high ? [`${high} high risk`] : []), ...(medium ? [`${medium} medium risk`] : [])];
  const rows: RenderLine[] = [
    panelTopLine("plan-top", "Plan approval", width, "running"),
    panelContentLine("plan-title", plan.summary, "tool", { width, tone: "running", bold: true }),
    panelContentLine("plan-risks", risks.join("  ·  "), "muted", { width, dim: true }),
  ];
  for (const [index, step] of plan.steps.slice(0, 4).entries()) {
    rows.push(panelContentLine(
      `plan-step-${step.id ?? index}`,
      `${todoIcon(executionStepStatusToTodoStatus(step.status))} ${index + 1}. ${step.description}`,
      "muted",
      {
        width,
        dim: step.status === "completed" || step.status === "skipped",
        strikethrough: step.status === "completed",
      },
    ));
  }
  if (plan.steps.length > 4) rows.push(panelContentLine("plan-more", `… ${plan.steps.length - 4} more steps`, "muted", { width, dim: true }));
  rows.push(
    panelContentLine("plan-options", "❯ Approve    Reject", "assistant", { width, tone: "running", bold: true }),
    panelContentLine("plan-keys", "A approve  ·  R reject", "muted", { width, dim: true }),
    panelBottomLine("plan-bottom", width),
  );
  return rows;
}

/** Terminal rows for command, session, file, and model candidates. */
export function autocompleteRenderLines(state?: TerminalAutocompleteState): RenderLine[] {
  if (!state?.mode) return [];
  if (state.mode === "session-list") {
    const rows: RenderLine[] = [
      {
        key: "autocomplete-session-title",
        text: state.sessionCommand === "resume" ? "Resume sessions" : "Saved sessions",
        prefix: "⌘ ",
        style: "muted",
        bold: true,
      },
    ];
    if (state.sessionLoading) {
      rows.push({ key: "autocomplete-session-loading", text: "Loading saved sessions…", style: "muted", dim: true });
    } else if (state.sessions.length === 0) {
      rows.push({ key: "autocomplete-session-empty", text: "No saved sessions", style: "muted", tone: "running", dim: true });
    } else {
      const pageSize = 8;
      const start = Math.max(0, Math.min(
        state.index - pageSize + 1,
        state.sessions.length - pageSize,
      ));
      for (const [offset, session] of state.sessions.slice(start, start + pageSize).entries()) {
        const index = start + offset;
        const preview = session.preview.replace(/\s+/g, " ").trim();
        const detail = [
          `${session.messageCount} msgs`,
          preview ? preview.slice(0, 48) : undefined,
        ].filter(Boolean).join(" · ");
        rows.push({
          key: `autocomplete-session-${session.id}`,
          text: `${index === state.index ? "❯" : " "} ${session.id.slice(0, 12)}  ${detail}`,
          style: index === state.index ? "assistant" : "muted",
          tone: index === state.index ? "running" : "default",
        });
      }
      if (state.sessions.length > pageSize) {
        const end = Math.min(start + pageSize, state.sessions.length);
        rows.push({ key: "autocomplete-session-more", text: `Showing ${start + 1}-${end} / ${state.sessions.length}`, style: "muted", dim: true });
      }
    }
    rows.push({
      key: "autocomplete-session-hint",
      text: SESSION_PICKER_HINT,
      style: "muted",
      dim: true,
    });
    return rows;
  }
  const rows: RenderLine[] = [];
  const values = state.argumentCandidates && state.argumentPrefix
    ? state.argumentCandidates
    : state.mode === "command" ? state.commands.map((item) => `/${item.name}`)
    : state.mode === "file" ? state.files
      : state.models;
  const title = state.argumentCandidates && state.argumentPrefix
    ? `${state.argumentPrefix.trim()} arguments`
    : state.mode === "command" ? "Commands" : state.mode === "file" ? `Files ${state.fileFragment}` : "Models";
  if (state.mode === "model-setup" && state.modelSetup) {
    const setup = state.modelSetup;
    return [
      { key: "autocomplete-model-setup-title", text: "Configure model", prefix: "⚙ ", style: "assistant", tone: "running", bold: true },
      { key: "autocomplete-model-setup-model", text: `Model: ${setup.model.provider}/${setup.model.id}`, style: "muted" },
      { key: "autocomplete-model-setup-url", text: `Base URL: ${setup.field === "baseUrl" ? "editing" : setup.baseUrl}`, style: "muted", dim: true },
      { key: "autocomplete-model-setup-key", text: `API key: ${setup.field === "apiKey" ? "editing" : "set"}`, style: "muted", dim: true },
      ...(setup.error ? [{ key: "autocomplete-model-setup-error", text: setup.error, style: "error" as const, tone: "error" as const }] : []),
      { key: "autocomplete-model-setup-hint", text: "Enter confirm field  ·  Esc cancel", style: "muted", dim: true },
    ];
  }
  if (state.mode === "profile-name" && state.pendingProfileSetup) {
    const setup = state.pendingProfileSetup;
    return [
      { key: "autocomplete-profile-name-title", text: "Save model profile", prefix: "▣ ", style: "assistant", tone: "running", bold: true },
      { key: "autocomplete-profile-name-model", text: `Model: ${setup.model.provider}/${setup.model.id}`, style: "muted" },
      { key: "autocomplete-profile-name-hint", text: "Type a profile name, Enter save, Esc skip", style: "muted", dim: true },
    ];
  }
  if (state.mode === "profile-list" && state.profileListState) {
    const profiles = state.profileListState.profiles;
    const selected = state.profileListState.selectedIndex;
    const visible = profiles.slice(Math.max(0, Math.min(selected - 9, profiles.length - 10)), Math.max(0, Math.min(selected - 9, profiles.length - 10)) + 10);
    const start = profiles.length === 0 ? 0 : Math.max(0, Math.min(selected - 9, profiles.length - 10));
    return [
      { key: "autocomplete-profile-list-title", text: "Model profiles", prefix: "▣ ", style: "assistant", tone: "running", bold: true },
      ...(profiles.length === 0
        ? [{ key: "autocomplete-profile-list-empty", text: "No saved profiles", style: "muted" as const, dim: true }]
        : visible.map((profile, index) => ({
          key: `autocomplete-profile-${profile.name}`,
          text: `${start + index === selected ? "❯" : " "} ${profile.active ? "✓" : " "} ${profile.name} (${profile.model})`,
          style: start + index === selected ? "assistant" as const : "muted" as const,
          tone: start + index === selected ? "running" as const : "default" as const,
        }))),
      ...(profiles.length > visible.length ? [{ key: "autocomplete-profile-list-more", text: `Showing ${start + 1}-${start + visible.length} / ${profiles.length}`, style: "muted" as const, dim: true }] : []),
      { key: "autocomplete-profile-list-hint", text: "↑↓ select  ·  Enter activate  ·  Esc cancel", style: "muted", dim: true },
    ];
  }
  rows.push({ key: "autocomplete-title", text: title, prefix: "⌘ ", style: "muted", bold: true });
  const visibleValues = values.slice(0, 12);
  if (visibleValues.length === 0) {
    rows.push({ key: "autocomplete-empty", text: state.mode === "model" || state.mode === "model-picker" ? "No matching models" : "No matches", style: "muted", tone: "running", dim: true });
  }
  for (const [index, value] of visibleValues.entries()) {
    rows.push({
      key: `autocomplete-${index}-${value}`,
      text: `${index === state.index ? "❯" : " "} ${value}`,
      style: index === state.index ? "assistant" : "muted",
      tone: index === state.index ? "running" : "default",
    });
  }
  if (values.length > visibleValues.length) {
    rows.push({ key: "autocomplete-more", text: `Showing ${visibleValues.length} / ${values.length}`, style: "muted", dim: true });
  }
  const hint = state.argumentCandidates && state.argumentPrefix
    ? "Tab/Enter select  ↑↓ navigate  Esc close"
    : state.mode === "command"
      ? "Tab/Enter select  ↑↓ navigate  Esc close"
      : state.mode === "file"
        ? "Tab/→ complete  ↑↓ navigate  Esc close"
        : "Enter select  ↑↓ navigate  Esc cancel";
  rows.push({ key: "autocomplete-hint", text: hint, style: "muted", dim: true });
  return rows;
}
