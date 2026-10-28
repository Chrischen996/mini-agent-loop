export type SmoothScrollScheduler = {
  now: () => number;
  request: (callback: () => void) => unknown;
  cancel: (handle: unknown) => void;
};

export type SmoothScrollOptions = {
  getOffset: () => number;
  getMaxOffset: () => number | undefined;
  scrollTo: (offset: number) => void;
  scheduler?: SmoothScrollScheduler;
};

const defaultScheduler: SmoothScrollScheduler = {
  now: () => performance.now(),
  request: (callback) => setTimeout(callback, 16),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function clampOffset(offset: number, maxOffset: number | undefined): number {
  const nonNegative = Math.max(0, offset);
  return maxOffset === undefined ? nonNegative : Math.min(maxOffset, nonNegative);
}

export class SmoothScrollController {
  private readonly scheduler: SmoothScrollScheduler;
  private position: number;
  private lastEmitted: number;
  private animation?: { from: number; to: number; startedAt: number; duration: number };
  private timer?: unknown;

  constructor(private readonly options: SmoothScrollOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.position = options.getOffset();
    this.lastEmitted = this.position;
  }

  scrollBy(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return;

    const now = this.scheduler.now();
    const previousTarget = this.animation?.to ?? this.options.getOffset();
    const currentPosition = this.sample(now);
    const target = clampOffset(previousTarget + delta, this.options.getMaxOffset());
    this.cancelTimer();
    this.position = currentPosition;

    if (target === currentPosition) {
      this.animation = undefined;
      this.emit(Math.round(target));
      return;
    }

    const distance = Math.abs(target - currentPosition);
    this.animation = {
      from: currentPosition,
      to: target,
      startedAt: now,
      duration: Math.min(260, Math.max(90, 60 + distance * 6)),
    };
    this.schedule();
  }

  jumpTo(offset: number): void {
    this.cancelTimer();
    this.animation = undefined;
    this.position = clampOffset(offset, this.options.getMaxOffset());
    this.emit(Math.round(this.position));
  }

  sync(offset: number, force = false): void {
    if (!force && offset === this.lastEmitted) return;
    this.cancelTimer();
    this.animation = undefined;
    this.position = offset;
    this.lastEmitted = offset;
  }

  dispose(): void {
    this.cancelTimer();
    this.animation = undefined;
  }

  private sample(now: number): number {
    const animation = this.animation;
    if (!animation) return this.options.getOffset();

    const progress = Math.min(1, Math.max(0, (now - animation.startedAt) / animation.duration));
    const eased = 1 - (1 - progress) ** 3;
    this.position = animation.from + (animation.to - animation.from) * eased;
    return this.position;
  }

  private schedule(): void {
    this.timer = this.scheduler.request(() => {
      this.timer = undefined;
      const animation = this.animation;
      if (!animation) return;

      const now = this.scheduler.now();
      const position = this.sample(now);
      this.emit(Math.round(position));
      if (now - animation.startedAt >= animation.duration) {
        this.position = animation.to;
        this.animation = undefined;
        this.emit(Math.round(this.position));
        return;
      }
      this.schedule();
    });
  }

  private emit(offset: number): void {
    if (offset === this.lastEmitted) return;
    this.lastEmitted = offset;
    this.options.scrollTo(offset);
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    this.scheduler.cancel(this.timer);
    this.timer = undefined;
  }
}
