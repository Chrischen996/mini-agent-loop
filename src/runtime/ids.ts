import { randomUUID } from "node:crypto";

type BrandedId<Brand extends string> = string & { readonly __brand: Brand };

export type TaskId = BrandedId<"TaskId">;
export type JobId = BrandedId<"JobId">;
export type SessionId = BrandedId<"SessionId">;
export type WorkspaceId = BrandedId<"WorkspaceId">;
export type ExecutionId = BrandedId<"ExecutionId">;

function createId<Brand extends string>(prefix: string): BrandedId<Brand> {
  return `${prefix}_${randomUUID()}` as BrandedId<Brand>;
}

export const createTaskId = (): TaskId => createId<"TaskId">("task");
export const createJobId = (): JobId => createId<"JobId">("job");
export const createSessionId = (): SessionId => createId<"SessionId">("session");
export const createWorkspaceId = (): WorkspaceId => createId<"WorkspaceId">("workspace");
export const createExecutionId = (): ExecutionId => createId<"ExecutionId">("exec");
