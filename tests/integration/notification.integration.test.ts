import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConnection, createServer } from "node:net";
import type { Server } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { Pool } from "pg";
import { createCapture } from "./capture.js";
import type { createCapture as CaptureFactory } from "./capture.js";
import { loadDatabaseConfig } from "../../apps/server/src/config.js";
import { migrate } from "../../apps/server/src/db/migrate.js";
import { createApp } from "../../apps/server/src/app.js";
import { createMailCaptureServer } from "../../apps/server/src/mail-capture.js";
import { MailpitClient } from "../../apps/server/src/mailpit.js";
import { MailNotificationSender } from "../../apps/server/src/mail-notifications.js";
import { createNotificationReceiver } from "../../../j-groupware/apps/server/dist/notification-receiver.js";
import { NotificationStore } from "../../../j-groupware/apps/server/dist/db/notifications.js";
import { loadDatabaseConfig as loadGwaDatabaseConfig } from "../../../j-groupware/apps/server/dist/config.js";

async function smtpSend(
  port: number,
  tenant: string,
  recipients: readonly string[],
  headers: string,
) {
  const socket = createConnection({ host: "127.0.0.1", port });
  const lines: string[] = [];
  let buffer = "";
  let wake: (() => void) | undefined;
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      lines.push(buffer.slice(0, end + 1));
      buffer = buffer.slice(end + 1);
      wake?.();
    }
  });
  const readLine = async () => {
    while (!lines.length)
      await new Promise<void>((resolve) => (wake = resolve));
    wake = undefined;
    return lines.shift()!;
  };
  const readReply = async () => {
    const result: string[] = [];
    let line: string;
    do {
      line = await readLine();
      result.push(line);
    } while (line[3] === "-");
    return result;
  };
  const command = async (line: string) => {
    socket.write(line + "\r\n");
    return readReply();
  };
  const status = (reply: string[]) => Number(reply.at(-1)?.slice(0, 3));
  try {
    expect(status(await readReply())).toBe(220);
    expect(status(await command("EHLO mail-notification-fixture"))).toBe(250);
    expect(status(await command(`MAIL FROM:<sender@${tenant}.jgw.test>`))).toBe(
      250,
    );
    for (const recipient of recipients)
      expect(status(await command(`RCPT TO:<${recipient}>`))).toBe(250);
    expect(status(await command("DATA"))).toBe(354);
    socket.write(headers + "\r\n\r\nactual multi-recipient message\r\n.\r\n");
    const queued = await readReply();
    expect(status(queued)).toBe(250);
    const match = /queued as ([A-Za-z0-9]{22})/.exec(queued.at(-1)!);
    expect(match).not.toBeNull();
    await command("QUIT");
    return match![1]!;
  } finally {
    socket.destroy();
  }
}

async function ephemeralPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback port.");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("actual Mailpit SMTP envelope capture, notification outbox, and GWA delivery", () => {
  let mailPool: Pool | undefined;
  let capture: Awaited<ReturnType<typeof CaptureFactory>> | undefined;
  let proxy: Server | undefined;
  let gwaPool: Pool | undefined;
  let receiver: ReturnType<typeof createNotificationReceiver> | undefined;
  let mailApp: ReturnType<typeof createApp> | undefined;
  let sender: MailNotificationSender | undefined;
  let captureId: string | undefined;
  let mailId: string | undefined;
  let gwaTenant = "";
  let key = "";
  let gwaReceiverPort: number | undefined;
  let receiverPort: number | undefined;
  let tenant = "";
  const producerWebhookIds: string[] = [];

  beforeAll(async () => {
    if (process.env.JML_TEST_RUNTIME !== "isolated-cloud")
      throw new Error("Isolated mail notification test environment required.");
    tenant = "mail-notify-" + randomUUID().slice(0, 8);
    mailPool = new Pool(loadDatabaseConfig());
    await migrate(mailPool);
    const mailpitHttpPort = await ephemeralPort();
    const webhookPort = await ephemeralPort();
    capture = await createCapture(tenant, mailpitHttpPort, 0, [tenant], {
      webhookUrl: `http://127.0.0.1:${webhookPort}/internal/mailpit/webhook`,
    });
    const sourcePort = capture.smtpPort;
    proxy = createMailCaptureServer({
      port: await ephemeralPort(),
      upstreamHost: "127.0.0.1",
      upstreamPort: sourcePort,
      tenant,
      pool: mailPool,
    });
    await new Promise<void>((resolve, reject) => {
      proxy!.once("error", reject);
      proxy!.listen(0, "127.0.0.1", resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === "string" || address.port === 3001)
      throw new Error("Owned capture adapter port required.");
    receiverPort = address.port;

    mailApp = createApp({
      pool: mailPool,
      tenant,
      keycloakOrigin: "https://auth.jgw.test",
      mailpitOrigin: `http://127.0.0.1:${mailpitHttpPort}`,
      verifier: {
        verify: async () => {
          throw new Error("Webhook route must not verify a bearer.");
        },
      } as never,
    });
    mailApp.addHook("preHandler", async (request) => {
      if (
        request.url === "/internal/mailpit/webhook" &&
        request.headers["user-agent"]?.startsWith("Mailpit/")
      ) {
        const id = (request.body as { ID?: unknown } | undefined)?.ID;
        if (typeof id === "string") producerWebhookIds.push(id);
      }
    });
    await mailApp.listen({ host: "127.0.0.1", port: webhookPort });
    expect(capture.configuration().NetworkMode).toBe("host");

    const gwaEnvPath =
      process.env.JGW_TEST_ENV ??
      "/workspace/.suite-runtime/j-groupware/integration.env";
    const gwaEnv = parseEnv(await readFile(gwaEnvPath, "utf8"));
    gwaPool = new Pool(loadGwaDatabaseConfig(gwaEnv));
    gwaTenant = tenant;
    key = randomUUID().replaceAll("-", "") + "mailfixture";
    const store = new NotificationStore(gwaPool, gwaTenant);
    await store.configure({
      "j-mail": [createHash("sha256").update(key).digest("hex")],
    });
    receiver = createNotificationReceiver(store);
    await receiver.listen({ host: "127.0.0.1", port: 0 });
    const receiverAddress = receiver.server.address();
    if (
      !receiverAddress ||
      typeof receiverAddress === "string" ||
      receiverAddress.port === 3001
    )
      throw new Error("Owned GWA receiver port required.");
    gwaReceiverPort = receiverAddress.port;
  }, 120000);

  afterAll(async () => {
    await sender?.stop();
    await mailApp?.close();
    if (receiver?.server.listening) await receiver.close();
    if (proxy?.listening)
      await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    if (gwaPool && gwaTenant) {
      await gwaPool.query(
        "DELETE FROM notifications WHERE tenant_id=$1 AND service='j-mail' AND dedup_key=$2",
        [gwaTenant, mailId ?? ""],
      );
      await gwaPool.query(
        "DELETE FROM notification_services WHERE tenant_id=$1 AND service='j-mail'",
        [gwaTenant],
      );
      await gwaPool.end();
    }
    if (mailPool && mailId)
      await mailPool.query(
        "DELETE FROM notification_outbox WHERE tenant_id=$1 AND mailpit_message_id=$2",
        [tenant, mailId],
      );
    if (mailPool && captureId)
      await mailPool.query(
        "DELETE FROM smtp_envelope_captures WHERE capture_id=$1",
        [captureId],
      );
    if (!producerWebhookIds.length && capture)
      process.stderr.write(
        `isolated Mailpit webhook diagnostics:\n${capture.logs()}\n`,
      );
    await capture?.close();
    await mailPool?.end();
  }, 120000);

  it("captures every actual accepted SMTP recipient, resolves a native Mailpit ID, deduplicates webhooks, and retries after GWA outage", async () => {
    const first = `first-${randomUUID().slice(0, 8)}`;
    const second = `second-${randomUUID().slice(0, 8)}`;
    const spoofed =
      "X-JGW-Capture-ID: client-controlled\r\nTo: decoy@other-tenant.jgw.test\r\nSubject: envelope-proof";
    mailId = await smtpSend(
      receiverPort!,
      tenant,
      [`${first}@${tenant}.jgw.test`, `${second}@${tenant}.jgw.test`],
      spoofed,
    );

    const headers = await new MailpitClient(
      capture!.origin,
      tenant,
    ).messageHeaders(mailId);
    const markers = Object.entries(headers)
      .filter(([name]) => name.toLowerCase() === "x-jgw-capture-id")
      .flatMap(([, values]) => values);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatch(/^[0-9a-f-]{36}$/);
    captureId = markers[0]!;
    const captureRow = (
      await mailPool!.query<{ usernames: string[]; message_id: string }>(
        "SELECT usernames,message_id FROM smtp_envelope_captures WHERE capture_id=$1",
        [captureId],
      )
    ).rows[0];
    expect(captureRow).toEqual({
      usernames: [first, second].sort(),
      message_id: mailId,
    });

    const producerDeadline = Date.now() + 10000;
    let actualOutboxCount = "0";
    while (Date.now() < producerDeadline) {
      actualOutboxCount =
        (
          await mailPool!.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM notification_outbox WHERE tenant_id=$1 AND mailpit_message_id=$2",
            [tenant, mailId],
          )
        ).rows[0]?.count ?? "0";
      if (actualOutboxCount !== "0" && producerWebhookIds.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(producerWebhookIds).toEqual([mailId]);
    expect(actualOutboxCount).toBe("1");

    const webhook = {
      ID: mailId,
      To: [{ Address: "decoy@other-tenant.jgw.test" }],
    };
    const firstWebhook = await mailApp!.inject({
      method: "POST",
      url: "/internal/mailpit/webhook",
      payload: webhook,
    });
    const repeatedWebhook = await mailApp!.inject({
      method: "POST",
      url: "/internal/mailpit/webhook",
      payload: webhook,
    });
    expect(firstWebhook.statusCode).toBe(204);
    expect(repeatedWebhook.statusCode).toBe(204);
    expect(producerWebhookIds).toEqual([mailId]);
    const outbox = await mailPool!.query<{
      count: string;
      usernames: string[];
    }>(
      "SELECT count(*)::text AS count,(array_agg(usernames))[1] AS usernames FROM notification_outbox WHERE tenant_id=$1 AND mailpit_message_id=$2",
      [tenant, mailId],
    );
    expect(outbox.rows[0]).toEqual({
      count: "1",
      usernames: [first, second].sort(),
    });
    const unknownCapture = await mailApp!.inject({
      method: "POST",
      url: "/internal/mailpit/webhook",
      payload: { ID: "Z".repeat(22) },
    });
    expect(unknownCapture.statusCode).toBe(503);

    // Stop the real isolated receiver to force a connection failure.
    await receiver!.close();
    receiver = undefined;
    const stoppedPort = gwaReceiverPort!;
    sender = new MailNotificationSender(
      mailPool!,
      tenant,
      `http://127.0.0.1:${stoppedPort}`,
      key,
    );
    expect(await sender.tick()).toBe(true);
    const delay = await mailPool!.query<{ seconds: number }>(
      "SELECT ceil(extract(epoch from available_at-clock_timestamp()))::int AS seconds FROM notification_outbox WHERE tenant_id=$1 AND mailpit_message_id=$2",
      [tenant, mailId],
    );
    const wait = Math.max(0, Number(delay.rows[0]?.seconds ?? 0));
    if (wait)
      await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
    await sender.stop();

    const store = new NotificationStore(gwaPool!, gwaTenant);
    receiver = createNotificationReceiver(store);
    await receiver.listen({ host: "127.0.0.1", port: gwaReceiverPort! });
    sender = new MailNotificationSender(
      mailPool!,
      tenant,
      `http://127.0.0.1:${gwaReceiverPort}`,
      key,
    );
    expect(await sender.tick()).toBe(true);
    const delivered = await gwaPool!.query<{
      type: string;
      dedup_key: string;
      target: { usernames?: string[] };
    }>(
      "SELECT type,dedup_key,target FROM notifications WHERE tenant_id=$1 AND service='j-mail' AND dedup_key=$2",
      [gwaTenant, mailId],
    );
    expect(delivered.rows).toEqual([
      {
        type: "mail.new",
        dedup_key: mailId,
        target: { usernames: [first, second].sort() },
      },
    ]);
  }, 60000);
});
