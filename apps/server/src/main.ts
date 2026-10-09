import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./app.js";
import { createMailCaptureServer } from "./mail-capture.js";
import { MailNotificationSender } from "./mail-notifications.js";
async function main() {
  const config = loadConfig(),
    pool = new Pool(config.database);
  let cleanup: () => Promise<void> = async () => undefined;
  let captureServer: ReturnType<typeof createMailCaptureServer> | undefined;
  try {
    await migrate(pool);
    if (config.smtpCapture) {
      captureServer = createMailCaptureServer({
        port: config.smtpCapture.port,
        upstreamHost: config.smtpCapture.upstreamHost,
        upstreamPort: config.smtpCapture.upstreamPort,
        tenant: config.tenant,
        pool,
      });
      await new Promise<void>((resolve, reject) => {
        captureServer!.once("error", reject);
        captureServer!.listen(config.smtpCapture!.port, "127.0.0.1", resolve);
      });
    }
    const [cert, key] = await Promise.all([
      readFile(config.tlsCertificate),
      readFile(config.tlsKey),
    ]);
    const app = createApp({
      pool,
      tenant: config.tenant,
      keycloakOrigin: config.keycloakOrigin,
      mailpitOrigin: config.mailpitOrigin,
      https: { cert, key, minVersion: "TLSv1.2" },
      logger: {
        level: "info",
        serializers: {
          req: () => ({}),
          res: () => ({}),
          err: () => ({ type: "Error", message: "Request failed.", stack: "" }),
        },
      },
    });
    const notificationSender = config.notification
      ? new MailNotificationSender(
          pool,
          config.tenant,
          config.notification.url,
          config.notification.key,
        )
      : undefined;
    app.addHook("onClose", async () => {
      await notificationSender?.stop();
      if (captureServer?.listening)
        await new Promise<void>((resolve, reject) =>
          captureServer!.close((error) => (error ? reject(error) : resolve())),
        );
    });
    app.addHook("onClose", () => pool.end());
    cleanup = () => app.close();
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        if (!closing) {
          closing = true;
          void app.close().catch(() => {
            process.exitCode = 1;
          });
        }
      });
    await app.listen({ host: "127.0.0.1", port: config.port });
    notificationSender?.start();
  } catch {
    await cleanup().catch(() => undefined);
    if (captureServer?.listening)
      await new Promise<void>((resolve) =>
        captureServer!.close(() => resolve()),
      );
    await pool.end().catch(() => undefined);
    throw new Error("Mail startup failed.");
  }
}
main().catch(() => {
  process.stderr.write(
    "Mail startup failed. No sensitive configuration was logged.\n",
  );
  process.exitCode = 1;
});
