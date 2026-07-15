import type { ModelRef } from "../models.ts";
import type { AgentMessage } from "../types.ts";

export type MessagePreprocessorContext = {
  userPrompt: string;
  targetModel: ModelRef;
};

export type MessagePreprocessor = {
  process: (
    messages: AgentMessage[],
    context: MessagePreprocessorContext,
  ) => Promise<AgentMessage[]>;
};
