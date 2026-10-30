import app from "./app";
import { logger } from "./lib/logger";
import { zaraVoiceJobs } from "./routes/zara";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function startServer() {
  if (process.env["ZARA_F5_WARMUP"] === "1") {
    try {
      await zaraVoiceJobs.warmup();
      logger.info("Zara approved reference voice preloaded");
    } catch {
      logger.warn("Zara approved reference voice preload failed; speech will report unavailable");
    }
  }

  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      zaraVoiceJobs.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

void startServer();
