import { randomUUID } from "node:crypto";
import { createPauseGate, type PauseGate } from "./pause-gate.ts";
import { JobStore } from "./job-store.ts";
import { assertJobTransition, type JobKind, type JobStatus, type OrchestrationEvent, type OrchestrationJob } from "./types.ts";

export type JobRunner = (context: JobRunnerContext) => Promise<string | void>;

export type JobRunnerContext = {
  job: OrchestrationJob;
  signal: AbortSignal;
  pauseGate: PauseGate;
  setStatus(status: Extract<JobStatus, "waiting_approval" | "running">, message?: string): Promise<void>;
  emit(type: string, message?: string, data?: Record<string, unknown>): Promise<void>;
};

type ActiveJob = {
  abort: AbortController;
  pauseGate: PauseGate;
};

export class JobManager {
  private readonly jobs = new Map<string, OrchestrationJob>();
  private readonly active = new Map<string, ActiveJob>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(job: OrchestrationJob) => void>();

  constructor(private readonly store: JobStore) {}

  async restore(): Promise<void> {
    for (const job of await this.store.list()) {
      if (["running", "waiting_approval", "paused"].includes(job.status)) {
        job.status = "failed";
        job.error = "Job interrupted by process restart; it must be retried explicitly.";
        job.updatedAt = Date.now();
        job.completedAt = Date.now();
        job.events = [...(job.events ?? []), { type: "interrupted", at: Date.now(), message: job.error }];
        await this.store.save(job);
      }
      this.jobs.set(job.id, job);
    }
  }

  onChange(listener: (job: OrchestrationJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async create(input: { sessionId: string; task: string; kind?: JobKind; workOrder?: OrchestrationJob["workOrder"] }): Promise<OrchestrationJob> {
    const now = Date.now();
    const job: OrchestrationJob = {
      id: `job_${randomUUID()}`,
      sessionId: input.sessionId,
      kind: input.kind ?? "agent_turn",
      task: input.task,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      events: [{ type: "queued", at: now }],
      ...(input.workOrder ? { workOrder: input.workOrder } : {}),
    };
    this.jobs.set(job.id, job);
    await this.store.save(job);
    this.notify(job);
    return job;
  }

  get(id: string): OrchestrationJob | undefined {
    return this.jobs.get(id);
  }

  list(sessionId?: string): OrchestrationJob[] {
    return [...this.jobs.values()]
      .filter((job) => !sessionId || job.sessionId === sessionId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async start(id: string, runner: JobRunner): Promise<OrchestrationJob> {
    const job = this.require(id);
    assertJobTransition(job.status, "running");
    if (this.active.has(id)) throw new Error(`Orchestration job is already active: ${id}`);
    const active: ActiveJob = { abort: new AbortController(), pauseGate: createPauseGate() };
    this.active.set(id, active);
    try {
      await this.update(job, "running", "started");
    } catch (error) {
      this.active.delete(id);
      throw error;
    }
    void this.run(job, active, runner);
    return job;
  }

  async pause(id: string): Promise<OrchestrationJob> {
    const job = this.require(id);
    const active = this.active.get(id);
    if (!active || !["running", "waiting_approval"].includes(job.status)) return job;
    active.pauseGate.pause();
    await this.update(job, "paused", "paused by user");
    return job;
  }

  async resume(id: string): Promise<OrchestrationJob> {
    const job = this.require(id);
    const active = this.active.get(id);
    if (!active || job.status !== "paused") return job;
    active.pauseGate.resume();
    await this.update(job, "running", "resumed by user");
    return job;
  }

  async cancel(id: string): Promise<OrchestrationJob> {
    const job = this.require(id);
    const active = this.active.get(id);
    if (!active) {
      if (job.status === "queued") await this.update(job, "cancelled", "cancelled before start");
      return job;
    }
    active.abort.abort(new Error("Job cancelled by user"));
    active.pauseGate.resume();
    if (!["completed", "failed", "cancelled"].includes(job.status)) {
      await this.update(job, "cancelled", "cancel requested");
    }
    return job;
  }

  async retry(id: string): Promise<OrchestrationJob> {
    const job = this.require(id);
    assertJobTransition(job.status, "queued");
    job.error = undefined;
    job.result = undefined;
    job.completedAt = undefined;
    await this.update(job, "queued", "queued for retry");
    return job;
  }

  private async run(job: OrchestrationJob, active: ActiveJob, runner: JobRunner): Promise<void> {
    try {
      const result = await runner({
        job,
        signal: active.abort.signal,
        pauseGate: active.pauseGate,
        setStatus: (status, message) => this.update(job, status, message),
        emit: (type, message, data) => this.appendEvent(job, { type, at: Date.now(), ...(message ? { message } : {}), ...(data ? { data } : {}) }),
      });
      if (job.status === "cancelled") return;
      if (result !== undefined) job.result = result;
      await this.update(job, "completed", "completed");
    } catch (error) {
      if (job.status === "cancelled" || active.abort.signal.aborted) {
        job.error = error instanceof Error ? error.message : "Job cancelled";
        await this.store.save(job);
      } else {
        job.error = error instanceof Error ? error.message : String(error);
        await this.update(job, "failed", job.error);
      }
    } finally {
      this.active.delete(job.id);
    }
  }

  private require(id: string): OrchestrationJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Orchestration job not found: ${id}`);
    return job;
  }

  private async update(job: OrchestrationJob, status: JobStatus, message?: string): Promise<void> {
    await this.enqueueMutation(job.id, async () => {
      if (job.status !== status) assertJobTransition(job.status, status);
      job.status = status;
      job.updatedAt = Date.now();
      if (status === "running") job.startedAt ??= job.updatedAt;
      if (["completed", "failed", "cancelled"].includes(status)) job.completedAt ??= job.updatedAt;
      await this.appendEventUnsafe(job, { type: status, at: job.updatedAt, ...(message ? { message } : {}) });
    });
  }

  private async appendEvent(job: OrchestrationJob, event: OrchestrationEvent): Promise<void> {
    await this.enqueueMutation(job.id, () => this.appendEventUnsafe(job, event));
  }

  private async appendEventUnsafe(job: OrchestrationJob, event: OrchestrationEvent): Promise<void> {
    job.events = [...(job.events ?? []), event].slice(-500);
    job.updatedAt = Date.now();
    await this.store.save(job);
    this.notify(job);
  }

  private async enqueueMutation(id: string, mutation: () => Promise<void>): Promise<void> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(id, next);
    try {
      await next;
    } finally {
      if (this.mutations.get(id) === next) this.mutations.delete(id);
    }
  }

  private notify(job: OrchestrationJob): void {
    for (const listener of this.listeners) {
      try { listener(job); } catch { /* observers cannot break the job */ }
    }
  }
}
