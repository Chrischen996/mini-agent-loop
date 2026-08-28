/**
 * Bounded command/prompt history for the standalone terminal input.
 *
 * Navigation keeps the draft that was present before the first Up press, so
 * Down can return to it without touching the Agent history.
 */
export class TerminalInputHistory {
  private readonly entries: string[] = [];
  private readonly maxEntries: number;
  private index = -1;
  private draft = "";

  constructor(maxEntries = 200) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  add(value: string): void {
    const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.trim()) return;
    if (this.entries.at(-1) !== normalized) this.entries.push(normalized);
    while (this.entries.length > this.maxEntries) this.entries.shift();
    this.resetNavigation();
  }

  navigate(direction: -1 | 1, currentValue: string): string | undefined {
    if (this.entries.length === 0) return undefined;
    // A fresh empty prompt has no forward history to browse. Let the caller
    // keep its normal Down-arrow behavior (usually viewport scrolling).
    if (direction > 0 && this.index === -1 && !currentValue) return undefined;
    if (this.index === -1) {
      this.draft = currentValue;
      this.index = this.entries.length;
    }

    if (direction < 0) {
      this.index = Math.max(0, this.index - 1);
    } else {
      this.index = Math.min(this.entries.length, this.index + 1);
    }
    return this.index === this.entries.length ? this.draft : this.entries[this.index];
  }

  resetNavigation(): void {
    this.index = -1;
    this.draft = "";
  }

  getEntries(): readonly string[] {
    return this.entries;
  }
}
