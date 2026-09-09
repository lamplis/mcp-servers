import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { DiskGate } from "../disk-gate.js";
import {
  addLocalDays,
  createFileLogger,
  formatLocalDate,
  parseLogLevel,
  parseRetentionDays,
  pruneOldLogs,
  sanitizeForLog,
} from "../logger.js";

class MemoryStderr extends Writable {
  chunks: string[] = [];
  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(String(chunk));
    callback();
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-logger-"));
}

function readLogLines(filePath: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return [];
  }
  return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("parseLogLevel / parseRetentionDays", () => {
  it("parses known levels and falls back", () => {
    expect(parseLogLevel("debug")).toBe("debug");
    expect(parseLogLevel("WARN")).toBe("warn");
    expect(parseLogLevel("nope")).toBe("info");
    expect(parseLogLevel(undefined)).toBe("info");
  });

  it("parses retention days and falls back", () => {
    expect(parseRetentionDays(undefined)).toBe(3);
    expect(parseRetentionDays("7")).toBe(7);
    expect(parseRetentionDays("0")).toBe(3);
    expect(parseRetentionDays("abc")).toBe(3);
  });
});

describe("sanitizeForLog", () => {
  it("redacts numeric vectors", () => {
    const vector = Array.from({ length: 384 }, (_, i) => i * 0.01);
    expect(sanitizeForLog({ points: [{ id: 1, vector }] })).toEqual({
      points: [{ id: 1, vector: { omitted: "vector", length: 384 } }],
    });
  });

  it("truncates long strings", () => {
    const text = "a".repeat(5000);
    const sanitized = sanitizeForLog(text, { maxStringBytes: 2048 }) as {
      omitted: string;
      length: number;
      preview: string;
    };
    expect(sanitized.omitted).toBe("string");
    expect(sanitized.length).toBe(5000);
    expect(sanitized.preview.length).toBe(2048);
  });
});

describe("createFileLogger", () => {
  let logDir: string;

  afterEach(() => {
    if (logDir) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  it("writes one JSONL file named with the local calendar date", () => {
    logDir = makeTempDir();
    const now = new Date(2026, 8, 9, 18, 5, 0);
    const logger = createFileLogger({
      logDir,
      now: () => now,
      stderr: new MemoryStderr(),
    });
    logger.info("lifecycle.start", { pid: 1 });
    const filePath = path.join(logDir, "2026-09-09.log");
    expect(fs.existsSync(filePath)).toBe(true);
    expect(logger.currentFilePath()).toBe(filePath);
    const lines = readLogLines(filePath);
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("lifecycle.start");
    expect(lines[0].level).toBe("info");
    expect((lines[0].fields as { pid: number }).pid).toBe(1);
  });

  it("rolls over at local midnight into a second daily file", () => {
    logDir = makeTempDir();
    let current = new Date(2026, 8, 9, 23, 59, 0);
    const logger = createFileLogger({
      logDir,
      now: () => current,
      stderr: new MemoryStderr(),
    });
    logger.info("day.one");
    current = new Date(2026, 8, 10, 0, 1, 0);
    logger.info("day.two");
    expect(fs.existsSync(path.join(logDir, "2026-09-09.log"))).toBe(true);
    expect(fs.existsSync(path.join(logDir, "2026-09-10.log"))).toBe(true);
    expect(readLogLines(path.join(logDir, "2026-09-09.log"))[0].event).toBe("day.one");
    expect(readLogLines(path.join(logDir, "2026-09-10.log"))[0].event).toBe("day.two");
  });

  it("prunes files older than 3 local days", () => {
    logDir = makeTempDir();
    const today = new Date(2026, 8, 9);
    for (const offset of [-5, -4, -3, -2, -1, 0]) {
      const name = `${formatLocalDate(addLocalDays(today, offset))}.log`;
      fs.writeFileSync(path.join(logDir, name), "{}\n");
    }
    fs.writeFileSync(path.join(logDir, "notes.txt"), "keep");
    const deleted = pruneOldLogs(logDir, "2026-09-09", 3);
    expect(deleted.sort()).toEqual([
      "2026-09-04.log",
      "2026-09-05.log",
      "2026-09-06.log",
    ]);
    expect(fs.existsSync(path.join(logDir, "2026-09-07.log"))).toBe(true);
    expect(fs.existsSync(path.join(logDir, "2026-09-08.log"))).toBe(true);
    expect(fs.existsSync(path.join(logDir, "2026-09-09.log"))).toBe(true);
    expect(fs.existsSync(path.join(logDir, "notes.txt"))).toBe(true);
  });

  it("mirrors warn and error to stderr and never writes stdout", () => {
    logDir = makeTempDir();
    const stderr = new MemoryStderr();
    const stdoutSpy = vi.spyOn(process.stdout, "write");
    const logger = createFileLogger({
      logDir,
      now: () => new Date(2026, 8, 9),
      stderr,
    });
    logger.info("quiet");
    logger.warn("careful", { reason: "test" });
    logger.error("boom");
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderr.chunks.join("")).toContain('"event":"careful"');
    expect(stderr.chunks.join("")).toContain('"event":"boom"');
    expect(stderr.chunks.join("")).not.toContain('"event":"quiet"');
    stdoutSpy.mockRestore();
  });

  it("queues appends through DiskGate until flush", async () => {
    logDir = makeTempDir();
    const diskGate = new DiskGate();
    const logger = createFileLogger({
      logDir,
      now: () => new Date(2026, 8, 9),
      stderr: new MemoryStderr(),
      diskGate,
    });
    logger.info("queued.one");
    logger.info("queued.two");
    await logger.flush();
    expect(readLogLines(path.join(logDir, "2026-09-09.log")).map((line) => line.event)).toEqual([
      "queued.one",
      "queued.two",
    ]);
  });

  it("respects log level so debug is dropped at info", () => {
    logDir = makeTempDir();
    const logger = createFileLogger({
      logDir,
      level: "info",
      now: () => new Date(2026, 8, 9),
      stderr: new MemoryStderr(),
    });
    logger.debug("hidden");
    logger.info("shown");
    const lines = readLogLines(path.join(logDir, "2026-09-09.log"));
    expect(lines.map((line) => line.event)).toEqual(["shown"]);
  });
});
