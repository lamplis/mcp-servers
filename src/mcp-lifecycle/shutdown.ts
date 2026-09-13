import type { Logger } from "./logger.js";

export interface ShutdownTransport {
  onclose?: (() => void) | null;
}

export interface ShutdownOptions {
  logger?: Logger;
  onShutdown: () => Promise<void> | void;
  onExitSync?: () => void;
  transport?: ShutdownTransport;
  stdin?: NodeJS.ReadableStream;
  hardExitMs?: number;
  exit?: (code: number) => void;
}

export function installShutdownHooks(options: ShutdownOptions): () => void {
  let shuttingDown = false;
  const hardExitMs = options.hardExitMs ?? 3000;
  const exitFn = options.exit ?? ((code: number) => process.exit(code));
  const handlers: Array<() => void> = [];

  const run = (code: number, reason: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    options.logger?.info("lifecycle.shutdown", { reason, code });
    const timer = setTimeout(() => {
      exitFn(code);
    }, hardExitMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => options.onShutdown())
      .catch((error) => {
        options.logger?.error("lifecycle.shutdown_error", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        clearTimeout(timer);
        exitFn(code);
      });
  };

  const onSigint = () => run(0, "SIGINT");
  const onSigterm = () => run(0, "SIGTERM");
  const onSighup = () => run(0, "SIGHUP");
  const onUncaught = (error: Error) => {
    options.logger?.error("process.uncaughtException", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    run(1, "uncaughtException");
  };
  const onRejection = (reason: unknown) => {
    options.logger?.error("process.unhandledRejection", {
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    run(1, "unhandledRejection");
  };

  const onBeforeExit = () => run(0, "beforeExit");

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGHUP", onSighup);
  process.on("beforeExit", onBeforeExit);
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  handlers.push(() => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGHUP", onSighup);
    process.off("beforeExit", onBeforeExit);
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
  });

  const stdin = options.stdin ?? (!process.stdin.isTTY ? process.stdin : undefined);
  if (stdin && !("readableEnded" in stdin && stdin.readableEnded)) {
    const onStdin = () => run(0, "stdin");
    stdin.on("end", onStdin);
    stdin.on("close", onStdin);
    handlers.push(() => {
      stdin.off("end", onStdin);
      stdin.off("close", onStdin);
    });
  }

  if (options.transport) {
    const previous = options.transport.onclose;
    options.transport.onclose = () => {
      previous?.();
      run(0, "transport.close");
    };
    handlers.push(() => {
      options.transport!.onclose = previous ?? undefined;
    });
  }

  if (options.onExitSync) {
    const onExit = () => {
      try {
        options.onExitSync?.();
      } catch {
        // Ignore sync cleanup errors during process exit.
      }
    };
    process.on("exit", onExit);
    handlers.push(() => {
      process.off("exit", onExit);
    });
  }

  return () => {
    shuttingDown = true;
    for (const dispose of handlers) {
      dispose();
    }
  };
}
