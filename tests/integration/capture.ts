import { spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { assertCustomerTenantId } from "@j-auth/contracts";

const image =
  "axllent/mailpit:v1.31.4@sha256:b68349e3a014b90c5610bfb26b2ae36f3892d7b8cf25ee140c6c71c98d2fcf48";
function docker(args: string[]): string {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0)
    throw new Error("Isolated Mailpit fixture command failed.");
  return r.stdout.trim();
}
export async function createCapture(
  tenant: string,
  httpPort = 0,
  smtpPort = 0,
) {
  if (process.env.JML_TEST_RUNTIME !== "isolated-cloud")
    throw new Error("Isolated mail fixture required. No skip.");
  assertCustomerTenantId(tenant);
  const root = await mkdtemp("/workspace/.suite-runtime/j-mail/cap-");
  const name = "j-mail-capture-" + randomUUID().slice(0, 8),
    sockets = new Set<Socket>();
  const bridges: ReturnType<typeof createServer>[] = [];
  let started = false;
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    for (const bridge of bridges)
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    if (started) docker(["rm", "-f", name]);
    await rm(root, { recursive: true, force: true });
  };
  try {
    docker([
      "run",
      "-d",
      "--name",
      name,
      "--network",
      "none",
      "--read-only",
      "--user",
      `${process.getuid!()}:${process.getgid!()}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--log-driver",
      "none",
      "--mount",
      `type=bind,source=${root},target=${root}`,
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--env",
      `MP_DATABASE=${root}/mailpit.db`,
      "--env",
      `MP_SMTP_BIND_ADDR=unix:${root}/smtp.sock:0600`,
      "--env",
      `MP_UI_BIND_ADDR=unix:${root}/http.sock:0600`,
      "--env",
      `MP_SMTP_ALLOWED_RECIPIENTS=(?i)^[^@\\s<>]+@${tenant}\\.jgw\\.test$`,
      "--env",
      "MP_SMTP_IGNORE_REJECTED_RECIPIENTS=false",
      "--env",
      "MP_DISABLE_VERSION_CHECK=true",
      "--env",
      "MP_SMTP_DISABLE_RDNS=true",
      "--env",
      "MP_USE_MESSAGE_DATES=false",
      "--env",
      "MP_MAX_MESSAGES=0",
      "--env",
      "MP_MAX_MESSAGE_SIZE=4",
      "--env",
      "MP_ALLOWED_HOSTS=127.0.0.1,localhost",
      "--env",
      "MP_QUIET=true",
      image,
    ]);
    started = true;
    const ready = async () => {
      for (let i = 0; i < 100; i++) {
        try {
          await stat(root + "/smtp.sock");
          await stat(root + "/http.sock");
          return;
        } catch {
          await delay(50);
        }
      }
      throw new Error("Mailpit sockets not ready.");
    };
    await ready();
    const bridge = async (path: string, port: number) => {
      const server = createServer((client) => {
        sockets.add(client);
        client.once("close", () => sockets.delete(client));
        const upstream = createConnection(path);
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
      });
      bridges.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Fixture bridge missing.");
      if (address.port === 3001) throw new Error("Reserved fixture port.");
      return address.port;
    };
    const http = await bridge(root + "/http.sock", httpPort),
      smtp = await bridge(root + "/smtp.sock", smtpPort);
    const origin = `http://127.0.0.1:${http}`;
    const api = async (route: string) => {
      const response = await fetch(origin + route, {
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Mailpit fixture API failed.");
      return response.json() as Promise<unknown>;
    };
    const send = async (
      recipients: readonly string[],
      headers: string,
      body = "fixture body",
    ) => {
      const socket = createConnection({ host: "127.0.0.1", port: smtp });
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const lines: string[] = [];
      let buffer = "",
        pending: ((line: string) => void) | undefined;
      let rejectWaiting: ((e: Error) => void) | undefined;
      socket.on("data", (data: Buffer) => {
        buffer += data;
        let p: number;
        while ((p = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, p).trimEnd();
          buffer = buffer.slice(p + 1);
          if (pending) {
            const r = pending;
            pending = undefined;
            rejectWaiting = undefined;
            r(line);
          } else lines.push(line);
        }
      });
      socket.on("error", () =>
        rejectWaiting?.(new Error("Fixture SMTP transport failed.")),
      );
      const next = () =>
        lines.length
          ? Promise.resolve(lines.shift()!)
          : new Promise<string>((resolve, reject) => {
              pending = resolve;
              rejectWaiting = reject;
            });
      const reply = async () => {
        let last: string;
        do {
          last = await next();
        } while (last[3] === "-");
        return Number(last.slice(0, 3));
      };
      const command = async (line: string) => {
        socket.write(line + "\r\n");
        return reply();
      };
      const timer = setTimeout(() => {
        rejectWaiting?.(new Error("Fixture SMTP timeout."));
        socket.destroy();
      }, 5000);
      try {
        if ((await reply()) !== 220) throw new Error("SMTP greeting failed.");
        await command("EHLO isolated-fixture");
        await command(`MAIL FROM:<sender@${tenant}.jgw.test>`);
        const statuses: number[] = [];
        for (const recipient of recipients)
          statuses.push(await command(`RCPT TO:<${recipient}>`));
        if (statuses.every((s) => s === 250)) {
          if ((await command("DATA")) !== 354)
            throw new Error("SMTP DATA refused.");
          socket.write(
            headers + "\r\n\r\n" + body.replace(/^\./gm, "..") + "\r\n.\r\n",
          );
          if ((await reply()) !== 250) throw new Error("SMTP capture failed.");
        }
        await command("QUIT");
        return statuses;
      } finally {
        clearTimeout(timer);
        socket.destroy();
      }
    };
    return {
      root,
      origin,
      api,
      send,
      close,
      restart: async () => {
        for (const socket of sockets) socket.destroy();
        docker(["restart", name]);
        await ready();
      },
      stopped: () => {
        for (const socket of sockets) socket.destroy();
        docker(["stop", name]);
      },
      start: async () => {
        docker(["start", name]);
        await ready();
      },
      configuration: () =>
        JSON.parse(
          docker(["inspect", name, "--format", "{{json .HostConfig}}"]),
        ) as {
          NetworkMode: string;
          CapDrop: string[];
          ReadonlyRootfs: boolean;
        },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
