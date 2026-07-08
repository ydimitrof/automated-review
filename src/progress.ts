// Multi-bar live progress region at the bottom of the terminal. One bar per
// in-flight review; log lines and other output scroll above via print().
// Enabled only on a TTY — otherwise every method is a no-op and callers fall
// back to plain log lines.

import { paint } from './logger.js';

const BAR_WIDTH = 16;
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const REDRAW_MS = 120;

interface Bar {
  label: string;
  total: number;
  done: number;
  startMs: number;
  finished: boolean;
}

/** Format a millisecond duration as `H:MM:SS` (or `MM:SS` under an hour). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Pure bar formatter (exported for testing). `nowMs` and `frame` are injected. */
export function formatBarLine(
  out: NodeJS.WriteStream,
  bar: Bar,
  frame: number,
  nowMs: number,
): string {
  const ratio = bar.total > 0 ? Math.min(1, bar.done / bar.total) : 0;
  const filled = Math.round(BAR_WIDTH * ratio);
  const gauge =
    paint(out, 'green', '█'.repeat(filled)) + paint(out, 'dim', '░'.repeat(BAR_WIDTH - filled));
  const spin = bar.finished ? paint(out, 'green', '✓') : paint(out, 'cyan', SPINNER[frame % SPINNER.length]);
  const elapsed = Math.max(0, Math.round((nowMs - bar.startMs) / 1000));
  const counts = `${bar.done}/${bar.total}`;
  return `${spin} ${paint(out, 'cyan', bar.label)} [${gauge}] ${counts} ${paint(out, 'dim', `${elapsed}s`)}`;
}

export class ProgressManager {
  private readonly out = process.stdout;
  readonly enabled: boolean;
  private readonly bars = new Map<string, Bar>();
  private status: string | null = null;
  private renderedLines = 0;
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    this.enabled = Boolean(this.out.isTTY);
  }

  private clearRegion(): void {
    if (this.renderedLines > 0) {
      // Move to the top of the region and clear everything below the cursor.
      this.out.write(`\x1b[${this.renderedLines}A\x1b[0J`);
      this.renderedLines = 0;
    }
  }

  private render(): void {
    this.clearRegion();
    const now = Date.now();
    const lines = [...this.bars.values()].map((b) => formatBarLine(this.out, b, this.frame, now));
    if (this.status) lines.push(this.status);
    if (lines.length === 0) return;
    this.out.write(lines.join('\n') + '\n');
    this.renderedLines = lines.length;
  }

  private ensureTimer(): void {
    if (this.timer || this.bars.size === 0) return;
    this.timer = setInterval(() => {
      this.frame++;
      this.render();
    }, REDRAW_MS);
    this.timer.unref(); // don't keep the process alive for the animation
  }

  private stopTimerIfIdle(): void {
    if (this.timer && this.bars.size === 0) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  start(id: string, label: string, total: number): void {
    if (!this.enabled) return;
    this.bars.set(id, { label, total, done: 0, startMs: Date.now(), finished: false });
    this.ensureTimer();
    this.render();
  }

  tick(id: string): void {
    if (!this.enabled) return;
    const bar = this.bars.get(id);
    if (bar) {
      bar.done = Math.min(bar.total, bar.done + 1);
      this.render();
    }
  }

  finish(id: string): void {
    if (!this.enabled) return;
    const bar = this.bars.get(id);
    if (!bar) return;
    // Draw the completed bar once (✓, full gauge), then drop it — the line is
    // cleared by the next clearRegion() (a log line, another render, or stop()).
    bar.finished = true;
    bar.done = bar.total;
    this.render();
    this.bars.delete(id);
    this.stopTimerIfIdle();
  }

  /** Set (or update) a persistent status line shown below the bars. */
  setStatus(text: string): void {
    if (!this.enabled) return;
    this.status = text;
    this.render();
  }

  /** Remove the status line. */
  clearStatus(): void {
    if (!this.enabled) return;
    this.status = null;
    this.render();
  }

  /** Print text above the live region (log lines, demo blocks). */
  print(text: string): void {
    if (!this.enabled) {
      this.out.write(text + '\n');
      return;
    }
    this.clearRegion();
    this.out.write(text + '\n');
    this.render();
  }

  /** Clear the region and stop animating (on shutdown). */
  stop(): void {
    if (!this.enabled) return;
    this.bars.clear();
    this.status = null;
    this.clearRegion();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
