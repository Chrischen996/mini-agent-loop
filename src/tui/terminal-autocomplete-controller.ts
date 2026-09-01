import type { CommandDef } from "./components/FileAutocomplete.tsx";
import { ARGUMENT_COMMANDS, PATH_COMMANDS } from "./slash-commands.ts";
import { listCandidates } from "./file-completion.ts";
import { modelChoices } from "./model-command.ts";
import type { ModelRef } from "../models.ts";
import type { PersistedSessionMeta } from "../session-store.ts";
import type { ModelSetupState, PendingProfileSetup, ProfileListState } from "./types.ts";
import { type AcMode, type FileAcTrigger } from "./input-utils.ts";
import {
  currentAutocompleteNavIndex,
  sessionListCommand,
  resolveAutocompleteInput,
  resolveAutocompleteNav,
  type AutocompleteNavKey,
} from "./autocomplete.ts";
import { SLASH_COMMANDS } from "./components/FileAutocomplete.tsx";

export type TerminalAutocompleteState = {
  mode: AcMode;
  index: number;
  commands: CommandDef[];
  files: string[];
  models: string[];
  sessions: PersistedSessionMeta[];
  modelContextWindows: Record<string, number>;
  modelQuery: string;
  fileFragment: string;
  modelSetup?: ModelSetupState;
  pendingProfileSetup?: PendingProfileSetup;
  profileListState?: ProfileListState;
  /** Candidate arguments for commands such as /tasks, /todo, /copy, and /resume. */
  argumentCandidates?: string[];
  argumentPrefix?: string;
  sessionCommand?: "resume" | "sessions";
  sessionLoading: boolean;
};

export type TerminalAutocompleteOptions = {
  cwd: string;
  getInput: () => string;
  setInput: (value: string) => void;
  onChange?: (state: TerminalAutocompleteState) => void;
  commands?: readonly CommandDef[];
  listSessionIds?: () => Promise<string[]>;
  listSessions?: () => Promise<PersistedSessionMeta[]>;
};

const EMPTY_STATE: TerminalAutocompleteState = {
  mode: null,
  index: 0,
  commands: [],
  files: [],
  models: [],
  sessions: [],
  modelContextWindows: {},
  modelQuery: "",
  fileFragment: "",
  modelSetup: undefined,
  pendingProfileSetup: undefined,
  profileListState: undefined,
  argumentCandidates: undefined,
  argumentPrefix: undefined,
  sessionCommand: undefined,
  sessionLoading: false,
};

/** Non-React counterpart of useAutocomplete for the ANSI entrypoint. */
export class TerminalAutocompleteController {
  private state: TerminalAutocompleteState = { ...EMPTY_STATE };
  private fileTrigger: FileAcTrigger | null = null;
  private requestId = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly options: TerminalAutocompleteOptions;

  constructor(options: TerminalAutocompleteOptions) {
    this.options = options;
  }

  getState(): TerminalAutocompleteState {
    return this.state;
  }

  update(input = this.options.getInput()): void {
    if (this.timer) clearTimeout(this.timer);
    const updateId = ++this.requestId;
    const argument = resolveArgumentInput(input);
    if (argument) {
      this.fileTrigger = null;
      const staticCandidates = argumentCandidates(argument.command);
      const pseudoCommand: CommandDef = {
        name: argument.command,
        usage: `${argument.prefix}<arg>`,
        description: "",
      };
      if (argument.command === "resume" && this.options.listSessionIds) {
        this.setState({
          ...EMPTY_STATE,
          mode: null,
          commands: [pseudoCommand],
          argumentPrefix: argument.prefix,
        });
        this.timer = setTimeout(async () => {
          const sessions = await this.options.listSessionIds!().catch(() => []);
          if (updateId !== this.requestId) return;
          const candidates = filterArguments(sessions, argument.query);
          this.setState({
            ...this.state,
            mode: candidates.length ? "command" : null,
            argumentCandidates: candidates,
            index: 0,
          });
        }, 0);
        return;
      }
      const candidates = filterArguments(staticCandidates, argument.query);
      this.setState({
        ...EMPTY_STATE,
        mode: candidates.length ? "command" : null,
        commands: candidates.length ? [pseudoCommand] : [],
        argumentCandidates: candidates,
        argumentPrefix: argument.prefix,
      });
      return;
    }
    const sessionCommand = sessionListCommand(input);
    if (sessionCommand && (this.options.listSessions || this.options.listSessionIds)) {
      this.fileTrigger = null;
      this.setState({
        ...EMPTY_STATE,
        mode: "session-list",
        sessionCommand,
        sessionLoading: true,
      });
      this.timer = setTimeout(async () => {
        const sessions = this.options.listSessions
          ? await this.options.listSessions().catch(() => [])
          : (await this.options.listSessionIds!().catch(() => [])).map((id) => ({
            id,
            createdAt: 0,
            lastActiveAt: 0,
            messageCount: 0,
            preview: "",
          }));
        if (updateId !== this.requestId) return;
        this.setState({
          ...this.state,
          mode: "session-list",
          sessions,
          sessionLoading: false,
          index: 0,
        });
      }, 0);
      return;
    }
    const resolution = resolveAutocompleteInput(input, this.state.mode, this.options.commands ?? SLASH_COMMANDS);
    if (resolution.kind === "sticky") return;
    if (resolution.kind === "model-picker") {
      const choices = modelChoices(resolution.query);
      this.setState({ ...EMPTY_STATE, mode: "model-picker", modelQuery: resolution.query, models: choices.references, modelContextWindows: choices.contextWindows });
      return;
    }
    if (resolution.kind === "command") {
      this.fileTrigger = null;
      this.setState({ ...EMPTY_STATE, mode: resolution.candidates.length ? "command" : null, commands: resolution.candidates });
      return;
    }
    if (resolution.kind === "model") {
      const choices = modelChoices(resolution.query);
      this.fileTrigger = null;
      this.setState({ ...EMPTY_STATE, mode: "model", modelQuery: resolution.query, models: choices.references, modelContextWindows: choices.contextWindows });
      return;
    }
    if (resolution.kind === "file") {
      this.fileTrigger = resolution.trigger;
      this.setState({ ...EMPTY_STATE, mode: null, fileFragment: resolution.trigger.fragment });
      this.timer = setTimeout(async () => {
        const files = await listCandidates(this.options.cwd, resolution.trigger.fragment);
        if (updateId !== this.requestId) return;
        this.setState({ ...this.state, mode: files.length ? "file" : null, files, index: 0 });
      }, 150);
      return;
    }
    this.fileTrigger = null;
    this.setState({ ...EMPTY_STATE });
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.requestId += 1;
    this.fileTrigger = null;
    this.setState({ ...EMPTY_STATE });
  }

  openModelPicker(query = "", models?: ModelRef[]): void {
    const choices = modelChoices(query, models);
    this.options.setInput(`/model ${query}`.trimEnd());
    this.setState({ ...EMPTY_STATE, mode: "model-picker", modelQuery: query, models: choices.references, modelContextWindows: choices.contextWindows });
  }

  openModelSetup(setup: ModelSetupState): void {
    this.setState({ ...EMPTY_STATE, mode: "model-setup", modelSetup: setup });
  }

  setModelSetup(setup: ModelSetupState | undefined): void {
    if (!setup) {
      this.clear();
      return;
    }
    this.setState({ ...this.state, mode: "model-setup", modelSetup: setup });
  }

  openProfileName(setup: PendingProfileSetup): void {
    this.setState({ ...EMPTY_STATE, mode: "profile-name", pendingProfileSetup: setup });
  }

  openProfileList(profileListState: ProfileListState): void {
    this.setState({ ...EMPTY_STATE, mode: "profile-list", profileListState });
  }

  handleKey(key: AutocompleteNavKey): boolean {
    const state = this.state;
    const navIndex = currentAutocompleteNavIndex(state.mode, state.index, state.profileListState?.selectedIndex ?? 0);
    const action = resolveAutocompleteNav(state.mode, key, navIndex, {
      commands: state.argumentCandidates?.length ?? state.commands.length,
      files: state.files.length,
      models: state.models.length,
      profiles: state.profileListState?.profiles.length ?? 0,
      sessions: state.sessions.length,
    });
    switch (action.type) {
      case "none": return false;
      case "ignore": return true;
      case "move":
        if (state.mode === "profile-list" && state.profileListState) {
          this.setState({ ...state, profileListState: { ...state.profileListState, selectedIndex: action.index } });
        } else {
          this.setState({ ...state, index: action.index });
        }
        return true;
      case "accept-command": {
        if (state.argumentCandidates && state.argumentPrefix) {
          const chosen = state.argumentCandidates[state.index];
          if (chosen) this.options.setInput(`${state.argumentPrefix}${chosen}`);
          this.clear();
          return true;
        }
        const command = state.commands[state.index];
        if (!command) return true;
        this.options.setInput(PATH_COMMANDS.has(command.name) || ARGUMENT_COMMANDS.has(command.name) ? `/${command.name} ` : `/${command.name}`);
        this.clear();
        return true;
      }
      case "accept-file": {
        const trigger = this.fileTrigger;
        const chosen = state.files[state.index];
        if (trigger && chosen) this.options.setInput(trigger.replaceFn(chosen));
        this.clear();
        return true;
      }
      case "accept-model": {
        const chosen = state.models[state.index];
        if (chosen) this.options.setInput(`/model ${chosen}`);
        this.clear();
        return true;
      }
      case "accept-session": {
        const session = state.sessions[state.index];
        if (session) this.options.setInput(`/resume ${session.id}`);
        this.clear();
        return true;
      }
      case "cancel":
        if (action.clearInput) this.options.setInput("");
        this.clear();
        return true;
    }
  }

  /** Start file completion when Tab is pressed before the debounced scan ran. */
  handleTab(): boolean {
    if (this.state.mode) return this.handleKey({ tab: true });
    if (this.state.argumentPrefix) return true;
    const resolution = resolveAutocompleteInput(this.options.getInput(), null, this.options.commands ?? SLASH_COMMANDS);
    if (resolution.kind !== "file") return false;
    this.update(this.options.getInput());
    return true;
  }

  private setState(next: TerminalAutocompleteState): void {
    this.state = next;
    this.options.onChange?.(next);
  }
}

const STATIC_ARGUMENTS: Record<string, readonly string[]> = {
  copy: ["last", "assistant", "input", "tool", "thinking", "user", "all"],
  tasks: ["show", "hide", "compact", "expanded", "clear"],
  todo: ["list", "add", "start", "pending", "done", "edit", "delete", "clear"],
  skill: ["list", "status", "ls", "on", "off", "clear", "only", "set"],
  skills: ["list", "status", "ls", "on", "off", "clear", "only", "set"],
  resume: [],
};

function resolveArgumentInput(input: string): { command: string; query: string; prefix: string } | undefined {
  const match = input.match(/^\/(copy|tasks|todo|skill|skills|resume)\s+([^\s]*)$/i);
  if (!match) return undefined;
  const command = match[1]!.toLowerCase();
  return { command, query: match[2] ?? "", prefix: `/${command} ` };
}

function argumentCandidates(command: string): readonly string[] {
  return STATIC_ARGUMENTS[command] ?? [];
}

function filterArguments(values: readonly string[], query: string): string[] {
  const needle = query.toLowerCase();
  return [...new Set(values)].filter((value) => value.toLowerCase().startsWith(needle));
}
