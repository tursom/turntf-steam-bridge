import { resolve } from "node:path";
import { createLogger, format, transports } from "winston";
import { loadConfig } from "./config.js";
import { Runtime } from "./runtime.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-config" || args[i] === "-c") {
      configPath = args[++i] || "";
    }
  }

  if (!configPath) {
    console.error("missing required -config <path>");
    process.exit(2);
  }

  configPath = resolve(configPath);

  const cfg = loadConfig(configPath);

  const logger = createLogger({
    level: "info",
    format: format.combine(
      format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
      format.printf(({ timestamp, level, message, ...rest }) => {
        const base = `${timestamp} [${level.toUpperCase()}] steambridge: ${message}`;
        const meta = Object.keys(rest).length > 0 ? " " + JSON.stringify(rest) : "";
        return base + meta;
      }),
    ),
    transports: [new transports.Console()],
  });

  const runtime = new Runtime(cfg, logger);

  const shutdown = async (signal: string) => {
    logger.info(`received ${signal}, shutting down...`);
    await runtime.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await runtime.start();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`steambridge failed to start: ${msg}`);
    await runtime.stop();
    process.exit(1);
  }

  await new Promise(() => {});
}

main().catch((err) => {
  console.error("steambridge fatal:", err);
  process.exit(1);
});
