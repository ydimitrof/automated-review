// Timestamped, optionally-colored stdout/stderr logging (ISO 8601 UTC).
// Color is disabled when NO_COLOR is set or the stream is not a TTY (e.g. piped
// to a file), so log files stay clean.

type Level = 'INFO' | 'WARN' | 'ERROR';

const CODES = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
} as const;

type Color = keyof typeof CODES;

function colorEnabled(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY);
}

/** Wrap text in an ANSI color if the target stream supports it. */
export function paint(stream: NodeJS.WriteStream, color: Color, text: string): string {
  return colorEnabled(stream) ? `${CODES[color]}${text}${CODES.reset}` : text;
}

const LEVEL_COLOR: Record<Level, Color> = {
  INFO: 'green',
  WARN: 'yellow',
  ERROR: 'red',
};

// Optional sink (e.g. the progress renderer) that takes ownership of printing so
// log lines can scroll above a live region. When unset, logs write directly.
type LogSink = (line: string) => void;
let sink: LogSink | null = null;

export function setLogSink(fn: LogSink | null): void {
  sink = fn;
}

function emit(level: Level, msg: string): void {
  const stream = level === 'ERROR' ? process.stderr : process.stdout;
  const ts = paint(stream, 'dim', new Date().toISOString());
  const label = paint(stream, LEVEL_COLOR[level], `[${level}]`);
  const line = `${ts} ${label} ${msg}`;
  if (sink) {
    sink(line);
  } else {
    stream.write(line + '\n');
  }
}

export const log = {
  info: (msg: string) => emit('INFO', msg),
  warn: (msg: string) => emit('WARN', msg),
  error: (msg: string, err?: unknown) => {
    const detail = err instanceof Error ? `: ${err.message}` : err !== undefined ? `: ${String(err)}` : '';
    emit('ERROR', msg + detail);
  },
};
