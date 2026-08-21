export type PauseGate = {
  wait(signal?: AbortSignal): Promise<void>;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
};

export function createPauseGate(): PauseGate {
  let paused = false;
  let waiters: Array<{
    resolve: () => void;
    reject: (reason?: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  const wait = (signal?: AbortSignal): Promise<void> => {
    if (!paused) {
      if (signal?.aborted) {
        return Promise.reject(signal.reason ?? Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
      }
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: {
        resolve: () => void;
        reject: (reason?: unknown) => void;
        signal?: AbortSignal;
        onAbort?: () => void;
      } = { resolve, reject, signal };
      const onAbort = () => {
        waiters = waiters.filter((item) => item !== waiter);
        reject(signal?.reason ?? Object.assign(new Error("Operation aborted"), { name: "AbortError" }));
      };
      waiter.onAbort = onAbort;
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(waiter);
      if (signal?.aborted) onAbort();
    });
  };

  const resume = () => {
    if (!paused) return;
    paused = false;
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      if (waiter.signal?.aborted) waiter.reject(waiter.signal.reason);
      else waiter.resolve();
    }
  };

  return {
    wait,
    pause: () => { paused = true; },
    resume,
    isPaused: () => paused,
  };
}
