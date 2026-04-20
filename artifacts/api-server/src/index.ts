import app from "./app";
import { logger } from "./lib/logger";
import { startBot } from "./bot";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startSelfPing();
});

startBot();

// ── Self-ping: hits our own /api/ping every 3 minutes to keep the Replit
// environment active regardless of external traffic.
function startSelfPing() {
  const domain = process.env["REPLIT_DEV_DOMAIN"];
  if (!domain) {
    logger.info("REPLIT_DEV_DOMAIN not set — self-ping disabled (UptimeRobot handles keep-alive)");
    return;
  }

  const url = `https://${domain}/api/ping`;
  logger.info({ url }, "Self-ping enabled (every 3 minutes)");

  async function ping() {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      logger.debug({ status: res.status }, "Self-ping OK");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, "Self-ping failed (non-fatal)");
    }
  }

  setInterval(ping, 3 * 60 * 1_000);
}
