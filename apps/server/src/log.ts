type Ctx = Record<string, unknown>;

function write(level: "info" | "warn" | "error", msg: string, ctx?: Ctx) {
  if (process.env.LOG_LEVEL === "silent") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...ctx });
  (level === "error" ? console.error : console.log)(line);
}

export const log = {
  info: (msg: string, ctx?: Ctx) => write("info", msg, ctx),
  warn: (msg: string, ctx?: Ctx) => write("warn", msg, ctx),
  error: (msg: string, ctx?: Ctx) => write("error", msg, ctx),
};

export function errInfo(err: unknown): Ctx {
  return err instanceof Error ? { error: err.message, stack: err.stack?.split("\n").slice(0, 4).join(" | ") } : { error: String(err) };
}
