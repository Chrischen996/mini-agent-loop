import {
  DeepWikiClient,
  loadDeepWikiConfigFromEnv,
} from "./deepwiki-client.ts";
import { DeepWikiProvider, type CodebaseSemanticProvider } from "./deepwiki-provider.ts";
import {
  createRepositoryStoreFromEnv,
  type RepositoryStore,
} from "./repository-store.ts";

export class CodebaseRuntime {
  readonly store: RepositoryStore;
  readonly semanticProvider: CodebaseSemanticProvider | undefined;
  readonly deepWikiEnabled: boolean;

  constructor(options: {
    store: RepositoryStore;
    semanticProvider?: CodebaseSemanticProvider;
    deepWikiEnabled: boolean;
  }) {
    this.store = options.store;
    this.semanticProvider = options.semanticProvider;
    this.deepWikiEnabled = options.deepWikiEnabled;
  }

  async close(): Promise<void> {
    await this.semanticProvider?.close();
    await this.store.close();
  }
}

export function createCodebaseRuntimeFromEnv(options: {
  rootDir?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): CodebaseRuntime {
  const store = createRepositoryStoreFromEnv(options.rootDir);
  const config = loadDeepWikiConfigFromEnv(options.environment);
  const client = config.enabled ? new DeepWikiClient(config) : undefined;
  return new CodebaseRuntime({
    store,
    semanticProvider: client ? new DeepWikiProvider(store, client) : undefined,
    deepWikiEnabled: config.enabled,
  });
}
