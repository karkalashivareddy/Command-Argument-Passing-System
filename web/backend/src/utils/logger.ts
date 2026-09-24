type Scope = "SERVER" | "EXECUTION" | "SSE" | "STORAGE" | "SECURITY";

const enabled = (process.env.CAPS_LOG_LEVEL ?? "info").toLowerCase();

function shouldLog(level: string): boolean {
  const order = ["debug", "info", "warn", "error"];
  return order.indexOf(level) >= order.indexOf(enabled);
}

function emit(level: "debug" | "info" | "warn" | "error", scope: Scope, msg: string, fields?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope.padEnd(10)} ${msg}` +
    (fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (scope: Scope, msg: string, fields?: Record<string, unknown>) => emit("debug", scope, msg, fields),
  info: (scope: Scope, msg: string, fields?: Record<string, unknown>) => emit("info", scope, msg, fields),
  warn: (scope: Scope, msg: string, fields?: Record<string, unknown>) => emit("warn", scope, msg, fields),
  error: (scope: Scope, msg: string, fields?: Record<string, unknown>) => emit("error", scope, msg, fields),
};