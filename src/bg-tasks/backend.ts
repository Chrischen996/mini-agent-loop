export type BgBackendKind = "tmux" | "process";

export type BackendStartResult = {
  pid?: number;
};

export interface BgTaskBackend {
  readonly kind: BgBackendKind;
  readonly socketName: string;

  assertAvailable(): Promise<void>;
  start(sessionName: string, cwd: string, taskDir: string, logPath: string): Promise<BackendStartResult>;
  pipePane(sessionName: string, logPath: string): Promise<void>;
  hasSession(sessionName: string, pid?: number, taskDir?: string): Promise<boolean>;
  sendLiteral(sessionName: string, text: string): Promise<void>;
  sendKey(sessionName: string, key: string): Promise<void>;
  capturePane(sessionName: string, lines?: number, logPath?: string): Promise<string>;
  kill(sessionName: string, pid?: number, force?: boolean, taskDir?: string): Promise<void>;
  dispose(): void;
}
