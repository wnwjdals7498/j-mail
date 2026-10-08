import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createApp } from "./app.js";
async function main() {
  const config = loadConfig(),
    pool = new Pool(config.database);
  let cleanup: () => Promise<void> = async () => undefined;
  try {
    await migrate(pool);
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
  } catch {
    await cleanup().catch(() => undefined);
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
