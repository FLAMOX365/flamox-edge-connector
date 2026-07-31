export type LogLevel = "error" | "warn" | "info" | "debug";

export type RuntimeLogger = {
  error: (...data: unknown[]) => void;
  warn: (...data: unknown[]) => void;
  info: (...data: unknown[]) => void;
  debug: (...data: unknown[]) => void;
};

type LogSink = Pick<Console, "debug" | "error" | "info" | "warn">;

const logLevels: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export const defaultLogLevel: LogLevel = "info";

export function isLogLevel(value: string): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" ||
    value === "debug";
}

export function createLogger(
  level: LogLevel = defaultLogLevel,
  sink: LogSink = console,
): RuntimeLogger {
  const enabled = logLevels[level];

  return {
    error: (...data) => sink.error(...format("error", data)),
    warn: (...data) => {
      if (enabled >= logLevels.warn) {
        sink.warn(...format("warn", data));
      }
    },
    info: (...data) => {
      if (enabled >= logLevels.info) {
        sink.info(...format("info", data));
      }
    },
    debug: (...data) => {
      if (enabled >= logLevels.debug) {
        sink.debug(...format("debug", data));
      }
    },
  };
}

function format(level: LogLevel, data: unknown[]): unknown[] {
  return [`[flamox-edge-connector] ${level.toUpperCase()}`, ...data];
}
