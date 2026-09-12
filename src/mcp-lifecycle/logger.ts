import fs from "node:fs";
import path from "node:path";
import type { DiskGate } from "./disk-gate.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const DATE_LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.log$/;
export const DEFAULT_RETENTION_DAYS = 3;
export const DEFAULT_MAX_STRING = 2048;
export const VECTOR_REDACT_MIN_LENGTH = 8;

export interface Logger {
  readonly logDir: string;
  currentFilePath(): string;
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  close(): void;
  flush(): Promise<void>;
}

export interface FileLoggerOptions {
  logDir: string;
  retentionDays?: number;
  level?: LogLevel;
  now?: () => Date;
  maxStringBytes?: number;
  redactVectors?: boolean;
  diskGate?: DiskGate;
  /** Writable for warn/error mirror. Defaults to process.stderr. Never stdout. */
  stderr?: NodeJS.WritableStream;
}

export interface SanitizeOptions {
  maxStringBytes?: number;
  redactVectors?: boolean;
  depth?: number;
}

export function parseLogLevel(
  value: string | undefined,
  fallback: LogLevel = "info"
): LogLevel {
  const normalized = (value ?? "").trim().toLowerCase();
  if (
    normalized === "debug" ||
    normalized === "info" ||
    normalized === "warn" ||
    normalized === "error"
  ) {
    return normalized;
  }
  return fallback;
}

export function parseRetentionDays(
  value: string | undefined,
  fallback = DEFAULT_RETENTION_DAYS
): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  return next;
}

function parseLocalDate(ymd: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) {
    return null;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Local-offset ISO so `ts` matches the YYYY-MM-DD.log file name. */
export function formatLocalIsoOffset(date: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const hours = pad(Math.floor(abs / 60));
  const minutes = pad(abs % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${hours}:${minutes}`;
}

export function isNumericVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length >= VECTOR_REDACT_MIN_LENGTH &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}

export function sanitizeForLog(
  value: unknown,
  options: SanitizeOptions = {}
): unknown {
  const maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING;
  const redactVectors = options.redactVectors ?? true;
  const depth = options.depth ?? 0;
  if (depth > 8) {
    return { omitted: "depth" };
  }
  if (value == null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") <= maxStringBytes) {
      return value;
    }
    return {
      omitted: "string",
      length: value.length,
      preview: value.slice(0, maxStringBytes),
    };
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (redactVectors && isNumericVector(value)) {
    return { omitted: "vector", length: value.length };
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      sanitizeForLog(item, { maxStringBytes, redactVectors, depth: depth + 1 })
    );
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeForLog(nested, {
        maxStringBytes,
        redactVectors,
        depth: depth + 1,
      });
    }
    return out;
  }
  return String(value);
}

export function createNoopLogger(logDir = ""): Logger {
  return {
    logDir,
    currentFilePath: () => "",
    debug() {},
    info() {},
    warn() {},
    error() {},
    close() {},
    async flush() {},
  };
}

export function createCallbackLogger(
  write: (message: string) => void,
  logDir = ""
): Logger {
  const emit = (
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>
  ) => {
    write(
      JSON.stringify({
        ts: formatLocalIsoOffset(new Date()),
        level,
        event,
        ...(fields ? { fields: sanitizeForLog(fields) } : {}),
      })
    );
  };
  return {
    logDir,
    currentFilePath: () => "",
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
    close() {},
    async flush() {},
  };
}

export function toLogger(
  logger?: Logger | ((message: string) => void)
): Logger {
  if (!logger) {
    return createCallbackLogger((message) => console.error(message));
  }
  if (typeof logger === "function") {
    return createCallbackLogger(logger);
  }
  return logger;
}

export function pruneOldLogs(
  logDir: string,
  today: string,
  retentionDays: number
): string[] {
  const deleted: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return deleted;
  }
  const todayDate = parseLocalDate(today);
  if (!todayDate) {
    return deleted;
  }
  const cutoff = formatLocalDate(addLocalDays(todayDate, -(retentionDays - 1)));
  for (const name of names) {
    const match = DATE_LOG_FILE_RE.exec(name);
    if (!match) {
      continue;
    }
    if (match[1] < cutoff) {
      try {
        fs.unlinkSync(path.join(logDir, name));
        deleted.push(name);
      } catch {
        // Ignore files we cannot delete.
      }
    }
  }
  return deleted;
}

export function createFileLogger(options: FileLoggerOptions): Logger {
  const logDir = path.resolve(options.logDir);
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const minLevel = options.level ?? "info";
  const now = options.now ?? (() => new Date());
  const maxStringBytes = options.maxStringBytes ?? DEFAULT_MAX_STRING;
  const redactVectors = options.redactVectors ?? true;
  const stderr = options.stderr ?? process.stderr;
  const diskGate = options.diskGate;

  fs.mkdirSync(logDir, { recursive: true });

  let currentDate = formatLocalDate(now());
  pruneOldLogs(logDir, currentDate, retentionDays);

  const persist = (fn: () => void): Promise<void> | void => {
    if (diskGate) {
      return diskGate.run(fn);
    }
    fn();
  };

  const write = (
    level: LogLevel,
    event: string,
    fields?: Record<string, unknown>
  ) => {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
      return;
    }
    const date = formatLocalDate(now());
    if (date !== currentDate) {
      currentDate = date;
      void persist(() => {
        pruneOldLogs(logDir, currentDate, retentionDays);
      });
    }
    const record: Record<string, unknown> = {
      ts: formatLocalIsoOffset(now()),
      level,
      event,
    };
    if (fields) {
      record.fields = sanitizeForLog(fields, { maxStringBytes, redactVectors });
    }
    const line = `${JSON.stringify(record)}\n`;
    const filePath = path.join(logDir, `${currentDate}.log`);
    void persist(() => {
      fs.appendFileSync(filePath, line, "utf8");
    });
    if (level === "warn" || level === "error") {
      stderr.write(line);
    }
  };

  return {
    logDir,
    currentFilePath: () => path.join(logDir, `${currentDate}.log`),
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    close() {},
    async flush() {
      if (diskGate) {
        await diskGate.drain();
      }
    },
  };
}
