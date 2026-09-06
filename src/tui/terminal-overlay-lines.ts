import type { ExecutionPlan } from "../plan-act/types.ts";
import type { PendingPermissionState } from "./state.ts";
import type { RenderLine } from "./render-lines.ts";
import type { TerminalAutocompleteState } from "./terminal-autocomplete-controller.ts";
import type { TodoEditorState } from "./todo-editor.ts";
import { PICKER_SELECTED_MARKER, PICKER_UNSELECTED_MARKER, TODO_EDITOR_DRAFT_HINT, TODO_EDITOR_SELECT_HINT, permissionRiskLabel, toolArgumentSummary } from "./claude-style.ts";
import { terminalStringWidth } from "./terminal-width.ts";
import { toolVisualName } from "./tool-lines.ts";
import { executionStepStatusToTodoStatus, todoIcon } from "./todo-format.ts";
import { SESSION_PICKER_HINT } from "./session-serialization.ts";
import { commandUsageColumn } from "./slash-commands.ts";
import {
  modelNameColumn,
  modelNameLabel,
  pickerHintText,
  pickerIsListMode,
  pickerPageItems,
  pickerRangeText,
  pickerTitleText,
  pickerVisibleWindow,
  profileRowText,
  sessionRowContent,
} from "./picker-window.ts";
import { formatContextWindow } from "./status-line.ts";

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

/**
 * Terminal row model for the same permission card rendered by Ink.
 *
 * Row-for-row identical to `PermissionPanel.tsx`: the caption lives in the
 * border, then the tool, the risk, the question, and one options row carrying
 * the key hints. The previous seven-row variant repeated "Permission required"
 * inside the card and split the choices from their keys, so the two clients
 * reserved a different number of rows for the same overlay.
 */
export function permissionPanelRenderLines(request?: PendingPermissionState, width?: number): RenderLine[] {
  if (!request) return [];
  const argument = toolArgumentSummary(request.tool, request.arguments ?? {});
  const target = argument ? ` (${argument})` : "";
  const risk = permissionRiskLabel(request.risk);
  const tone: PanelTone = request.risk === "high" ? "error" : "running";
  return [
    panelTopLine("permission-top", `⚠ Permission required`, width, tone),
    panelContentLine("permission-title", `${toolVisualName(request.tool)}${target}`, "assistant", { width, tone, bold: true }),
    panelContentLine("permission-risk", `Risk: ${risk}`, "muted", { width, dim: true }),
    panelContentLine("permission-question", "Do you want to proceed?", "assistant", { width }),
    panelContentLine("permission-options", `❯ A Allow  ·  D/Enter Deny  ·  Esc cancel`, "assistant", { width, tone: "running", bold: true }),
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
    panelTopLine("plan-top", "▣ Plan approval", width, "running"),
    panelContentLine("plan-title", plan.summary, "tool", { width, tone: "running", bold: true }),
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
    // Same order as the Ink approval bar: steps first, then the risk tally.
    panelContentLine("plan-risks", risks.join("  ·  "), "muted", { width, dim: true }),
    panelContentLine("plan-options", "❯ Approve  ·  Reject", "assistant", { width, tone: "running", bold: true }),
    panelContentLine("plan-keys", "A approve  ·  R reject", "muted", { width, dim: true }),
    panelBottomLine("plan-bottom", width),
  );
  return rows;
}

/**
 * Terminal rows for the interactive Todo editor overlay.
 *
 * Mirrors the permission/plan cards: a bordered panel listing each todo with
 * its status glyph, the selected row marked with `❯`, followed by the draft
 * line while adding or editing and a key hint footer.
 */
export function todoEditorRenderLines(state?: TodoEditorState, width?: number): RenderLine[] {
  if (!state) return [];
  const rows: RenderLine[] = [panelTopLine("todo-editor-top", "Todo editor", width, "running")];

  if (state.todos.length === 0) {
    rows.push(panelContentLine("todo-editor-empty", "No todos yet — press a to add one.", "muted", { width, dim: true }));
  } else {
    for (const [index, todo] of state.todos.entries()) {
      const selected = index === state.selectedIndex;
      rows.push(panelContentLine(
        `todo-editor-item-${todo.id}`,
        `${selected ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER} ${todoIcon(todo.status)} ${todo.content}`,
        selected ? "assistant" : "muted",
        {
          width,
          tone: selected ? "running" : undefined,
          bold: selected,
          dim: !selected && todo.status === "completed",
          strikethrough: todo.status === "completed",
        },
      ));
    }
  }

  if (state.mode !== "select") {
    rows.push(panelContentLine(
      "todo-editor-draft",
      `${state.mode === "add" ? "New" : "Edit"}: ${state.draft}`,
      "assistant",
      { width, tone: "running", bold: true },
    ));
  }
  if (state.error) {
    rows.push(panelContentLine("todo-editor-error", state.error, "error", { width, tone: "error" }));
  }

  rows.push(
    panelContentLine(
      "todo-editor-keys",
      state.mode === "select" ? TODO_EDITOR_SELECT_HINT : TODO_EDITOR_DRAFT_HINT,
      "muted",
      { width, dim: true },
    ),
    panelBottomLine("todo-editor-bottom", width),
  );
  return rows;
}

export type AutocompleteRenderContext = {
  /** Raw prompt text; the palette heading echoes the `/` filter from it. */
  input?: string;
  /** Active `provider/model` reference, marked with a ✓ in the model picker. */
  currentModel?: string;
  /**
   * Candidate rows the frame can still hold. Fullscreen modes reserve the
   * welcome panel and the prompt chrome first, so a short terminal shrinks the
   * picker (and drops it at zero) instead of cutting the panel mid-border.
   */
  maxItems?: number;
};

/** Terminal rows for command, session, file, and model candidates. */
export function autocompleteRenderLines(state?: TerminalAutocompleteState, context?: AutocompleteRenderContext): RenderLine[] {
  if (!state?.mode) return [];
  const maxItems = context?.maxItems;
  if (maxItems !== undefined && maxItems <= 0 && pickerIsListMode(state.mode)) return [];
  if (state.mode === "resume-messages") {
    const candidates = state.resumeMessages ?? [];
    const { visible, start } = pickerVisibleWindow(
      candidates,
      state.index,
      pickerPageItems("resume-messages", candidates.length, maxItems),
    );
    const rows: RenderLine[] = [
      { key: "autocomplete-resume-title", text: pickerTitleText("resume-messages"), prefix: "⌘ ", style: "muted", bold: true },
    ];
    if (candidates.length === 0) {
      rows.push({ key: "autocomplete-resume-empty", text: "No selectable messages", style: "muted", tone: "running", dim: true });
    }
    for (const [offset, candidate] of visible.entries()) {
      const index = start + offset;
      rows.push({
        key: `autocomplete-resume-${index}`,
        text: `${index === state.index ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER} ${candidate.role}  ${(candidate.text || "(tool call)").replace(/\s+/g, " ").slice(0, 72)}`,
        style: index === state.index ? "assistant" : "muted",
        tone: index === state.index ? "running" : "default",
      });
    }
    if (candidates.length > visible.length) {
      rows.push({
        key: "autocomplete-resume-more",
        text: pickerRangeText(start, visible.length, candidates.length),
        style: "muted",
        dim: true,
      });
    }
    rows.push({ key: "autocomplete-resume-hint", text: pickerHintText("resume-messages"), style: "muted", dim: true });
    return rows;
  }

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
      const { visible, start } = pickerVisibleWindow(
        state.sessions,
        state.index,
        pickerPageItems("session-list", state.sessions.length, maxItems),
      );
      for (const [offset, session] of visible.entries()) {
        const index = start + offset;
        rows.push({
          key: `autocomplete-session-${session.id}`,
          text: `${index === state.index ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER} ${sessionRowContent(session)}`,
          style: index === state.index ? "assistant" : "muted",
          tone: index === state.index ? "running" : "default",
        });
      }
      if (state.sessions.length > visible.length) {
        rows.push({
          key: "autocomplete-session-more",
          text: pickerRangeText(start, visible.length, state.sessions.length),
          style: "muted",
          dim: true,
        });
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

  const argumentPalette = Boolean(state.argumentCandidates && state.argumentPrefix);
  // The command palette shows the same `usage  description` columns as the Ink
  // FileAutocomplete overlay; it used to list bare names, so the two clients
  // advertised the catalog differently.
  const values = argumentPalette
    ? state.argumentCandidates!
    : state.mode === "command" ? state.commands.map((item) => item.usage)
    : state.mode === "file" ? state.files
      : state.models;
  // Second column: command descriptions and model context sizes, matching the
  // Ink FileAutocomplete/ModelPicker overlays.
  const details = argumentPalette
    ? []
    : state.mode === "command"
      ? state.commands.map((item) => item.description)
      : state.mode === "model" || state.mode === "model-picker"
        ? values.map((model) => `${formatContextWindow(state.modelContextWindows[model] ?? 0)} context`)
        : [];
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
    const { visible, start } = pickerVisibleWindow(
      profiles,
      selected,
      pickerPageItems("profile-list", profiles.length, maxItems),
    );
    return [
      { key: "autocomplete-profile-list-title", text: "Model profiles", prefix: "▣ ", style: "assistant", tone: "running", bold: true },
      ...(profiles.length === 0
        ? [{ key: "autocomplete-profile-list-empty", text: "No saved profiles", style: "muted" as const, dim: true }]
        : visible.map((profile, offset) => {
          const index = start + offset;
          return {
            key: `autocomplete-profile-${profile.name}`,
            text: profileRowText(profile, index === selected),
            style: index === selected ? "assistant" as const : "muted" as const,
            tone: index === selected ? "running" as const : "default" as const,
          };
        })),
      ...(profiles.length > visible.length ? [{ key: "autocomplete-profile-list-more", text: pickerRangeText(start, visible.length, profiles.length), style: "muted" as const, dim: true }] : []),
      { key: "autocomplete-profile-list-hint", text: pickerHintText("profile-list"), style: "muted", dim: true },
    ];
  }

  // Same page size, window, and clipped-list footer as the Ink overlays. The
  // ANSI palette used to hardcode twelve rows without scrolling, so arrowing
  // past row twelve moved the marker off screen.
  const modelRows = state.mode === "model" || state.mode === "model-picker";
  const { visible: visibleValues, start } = pickerVisibleWindow(values, state.index, pickerPageItems(state.mode, values.length, maxItems));
  const visibleDetails = details.slice(start, start + visibleValues.length);
  const labels = modelRows
    ? visibleValues.map((model) => modelNameLabel(model, model === context?.currentModel))
    : visibleValues;
  const detailColumn = visibleDetails.length === 0
    ? 0
    : state.mode === "command"
      ? commandUsageColumn(state.commands)
      : modelNameColumn(visibleValues);
  const title = pickerTitleText(state.mode, {
    argumentPrefix: state.argumentPrefix,
    filter: context?.input?.startsWith("/") ? context.input.slice(1) : "",
    fragment: state.fileFragment,
    query: state.modelQuery,
  });

  const rows: RenderLine[] = [
    { key: "autocomplete-title", text: title, prefix: "⌘ ", style: "muted", bold: true },
  ];
  if (visibleValues.length === 0) {
    rows.push({
      key: "autocomplete-empty",
      text: modelRows ? "No matching models" : state.mode === "command" ? "No matching commands" : "No matching files",
      style: "muted",
      tone: "running",
      dim: true,
    });
  }
  for (const [offset, label] of labels.entries()) {
    const index = start + offset;
    const detail = visibleDetails[offset];
    rows.push({
      key: `autocomplete-${index}-${label.trim()}`,
      text: `${index === state.index ? PICKER_SELECTED_MARKER : PICKER_UNSELECTED_MARKER} ${detailColumn > 0 && detail ? `${label.padEnd(Math.max(detailColumn, label.length + 2))}${detail}` : label}`,
      style: index === state.index ? "assistant" : "muted",
      tone: index === state.index ? "running" : "default",
    });
  }
  if (values.length > visibleValues.length) {
    rows.push({ key: "autocomplete-more", text: pickerRangeText(start, visibleValues.length, values.length), style: "muted", dim: true });
  }
  rows.push({ key: "autocomplete-hint", text: pickerHintText(state.mode, { argumentPalette }), style: "muted", dim: true });
  return rows;
}
