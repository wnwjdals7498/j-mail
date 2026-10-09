import { randomUUID } from "node:crypto";
import { createServer, connect } from "node:net";
import type { Server, Socket } from "node:net";
import type { Pool } from "pg";
import { assertCustomerTenantId } from "@j-auth/contracts";
import { MAIL_ID_PATTERN } from "@j-mail/contracts";

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_LINE_BYTES = 65536;
const marker = "X-JGW-Capture-ID";

class LineReader {
  private buffer = Buffer.alloc(0);
  private ended = false;
  private error: Error | undefined;
  private wake: (() => void) | undefined;

  constructor(private readonly socket: Socket) {
    socket.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      this.wake?.();
    });
    socket.once("end", () => {
      this.ended = true;
      this.wake?.();
    });
    socket.once("error", (error) => {
      this.error = error;
      this.wake?.();
    });
  }

  async line(): Promise<Buffer> {
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end >= 0) {
        if (end + 1 > MAX_LINE_BYTES) throw new Error("SMTP line too long.");
        const line = this.buffer.subarray(0, end + 1);
        this.buffer = this.buffer.subarray(end + 1);
        return line;
      }
      if (this.buffer.length > MAX_LINE_BYTES)
        throw new Error("SMTP line too long.");
      if (this.error) throw this.error;
      if (this.ended) throw new Error("SMTP peer closed.");
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = undefined;
    }
  }
}

async function reply(reader: LineReader): Promise<Buffer[]> {
  const lines: Buffer[] = [];
  let code = "";
  for (;;) {
    const line = await reader.line();
    const text = line.toString("ascii");
    const match = /^(\d{3})([ -])/.exec(text);
    if (!match) throw new Error("Invalid SMTP response.");
    if (!code) code = match[1]!;
    if (match[1] !== code) throw new Error("Invalid SMTP response sequence.");
    lines.push(line);
    if (match[2] === " ") return lines;
  }
}

async function write(socket: Socket, data: Buffer | string): Promise<void> {
  if (!socket.write(data))
    await new Promise<void>((resolve, reject) => {
      socket.once("drain", resolve);
      socket.once("error", reject);
    });
}

function smtpCode(lines: Buffer[]): number {
  const code = Number(lines.at(-1)?.toString("ascii").slice(0, 3));
  return Number.isInteger(code) ? code : 0;
}

function rcptAddress(line: Buffer): string | null {
  const match = /^RCPT\s+TO:\s*<([^<>\s]+)>/i.exec(
    line.toString("ascii").trimEnd(),
  );
  return match?.[1] ?? null;
}

function usernameFor(address: string, tenant: string): string | null {
  const match =
    /^([a-z0-9][a-z0-9._+-]{0,127})@([a-z0-9][a-z0-9-]{0,62})\.jgw\.test$/i.exec(
      address,
    );
  if (!match || match[2]!.toLowerCase() !== tenant) return null;
  const username = match[1]!.toLowerCase();
  if (username.startsWith("service-account-")) return null;
  return username;
}

function rewriteData(data: Buffer, captureId: string): Buffer {
  const split = data.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("SMTP message has no RFC header boundary.");
  const rawHeaders = data.subarray(0, split).toString("latin1").split("\r\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of rawHeaders) {
    if (/^[ \t]/.test(line)) {
      if (!skipping) kept.push(line);
      continue;
    }
    skipping = new RegExp(`^${marker}:`, "i").test(line);
    if (!skipping) kept.push(line);
  }
  kept.push(`${marker}: ${captureId}`);
  return Buffer.concat([
    Buffer.from(kept.join("\r\n") + "\r\n\r\n", "latin1"),
    data.subarray(split + 4),
  ]);
}

async function dataBlock(reader: LineReader): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const line = await reader.line();
    size += line.length;
    if (size > MAX_MESSAGE_BYTES) throw new Error("SMTP message too large.");
    if (line.equals(Buffer.from(".\r\n"))) return Buffer.concat(chunks);
    chunks.push(line);
  }
}

export interface MailCaptureOptions {
  readonly host?: string;
  readonly port: number;
  readonly upstreamHost: string;
  readonly upstreamPort: number;
  readonly tenant: string;
  readonly pool: Pool;
}

// Explicit opt-in source adapter. It is not started by default or wired into the
// shipped Mailpit Compose profile. One SMTP conversation is handled at a time so
// each upstream reply remains associated with the command and envelope it accepts.
export function createMailCaptureServer(options: MailCaptureOptions): Server {
  assertCustomerTenantId(options.tenant);
  if (
    options.port === 3001 ||
    options.upstreamPort === 3001 ||
    options.port === options.upstreamPort ||
    (options.host ?? "127.0.0.1") !== "127.0.0.1" ||
    options.upstreamHost !== "127.0.0.1"
  )
    throw new Error("Mail capture requires distinct explicit loopback ports.");

  const handle = async (client: Socket) => {
    const upstream = connect({
      host: options.upstreamHost,
      port: options.upstreamPort,
    });
    const inbound = new LineReader(client);
    const outbound = new LineReader(upstream);
    let accepted: string[] = [];
    let captureId: string | undefined;
    const sendCommand = async (line: Buffer) => {
      await write(upstream, line);
      const lines = await reply(outbound);
      for (const response of lines) await write(client, response);
      return smtpCode(lines);
    };
    try {
      for (const line of await reply(outbound)) await write(client, line);
      while (!client.destroyed && !upstream.destroyed) {
        const line = await inbound.line();
        const command = line
          .toString("ascii")
          .trimEnd()
          .split(/[ \t]/, 1)[0]!
          .toUpperCase();
        if (command === "RCPT") {
          const address = rcptAddress(line);
          const username = address
            ? usernameFor(address, options.tenant)
            : null;
          if (!username) {
            await write(
              client,
              "550 5.1.0 Requested action not taken: mailbox unavailable\r\n",
            );
            continue;
          }
          if ((await sendCommand(line)) < 300)
            accepted.push(address!.toLowerCase());
          continue;
        }
        if (
          command === "MAIL" ||
          command === "RSET" ||
          command === "EHLO" ||
          command === "HELO"
        ) {
          if (command !== "EHLO" && command !== "HELO") accepted = [];
          const status = await sendCommand(line);
          if (command === "MAIL" && status < 300) accepted = [];
          continue;
        }
        if (command === "DATA") {
          const usernames = [
            ...new Set(
              accepted.map((address) => usernameFor(address, options.tenant)),
            ),
          ]
            .filter((name): name is string => name !== null)
            .sort();
          if (!usernames.length) {
            await write(
              client,
              "503 5.5.1 No accepted recipients before DATA\r\n",
            );
            continue;
          }
          captureId = randomUUID();
          await options.pool.query(
            "INSERT INTO smtp_envelope_captures (capture_id, tenant_id, usernames, created_at) VALUES ($1,$2,$3::jsonb,clock_timestamp())",
            [captureId, options.tenant, JSON.stringify(usernames)],
          );
          await write(upstream, line);
          const ready = await reply(outbound);
          for (const response of ready) await write(client, response);
          if (smtpCode(ready) !== 354) {
            await options.pool
              .query(
                "DELETE FROM smtp_envelope_captures WHERE capture_id=$1 AND message_id IS NULL",
                [captureId],
              )
              .catch(() => undefined);
            accepted = [];
            captureId = undefined;
            continue;
          }
          const raw = await dataBlock(inbound);
          const rewritten = rewriteData(raw, captureId);
          await write(
            upstream,
            Buffer.concat([rewritten, Buffer.from(".\r\n")]),
          );
          const result = await reply(outbound);
          const final = result.at(-1)?.toString("ascii") ?? "";
          const messageId =
            /^250 2\.0\.0 Ok: queued as ([A-Za-z0-9]{22})\r?\n$/.exec(
              final,
            )?.[1];
          if (
            smtpCode(result) === 250 &&
            messageId &&
            new RegExp(`^${MAIL_ID_PATTERN}$`).test(messageId)
          ) {
            try {
              await options.pool.query(
                "UPDATE smtp_envelope_captures SET message_id=$2 WHERE capture_id=$1 AND (message_id IS NULL OR message_id=$2)",
                [captureId, messageId],
              );
            } catch {
              // The webhook can still finish the same link by reading the injected marker.
              // Do not turn an already-stored message into a false SMTP success receipt.
            }
          } else if (smtpCode(result) !== 250) {
            await options.pool
              .query(
                "DELETE FROM smtp_envelope_captures WHERE capture_id=$1 AND message_id IS NULL",
                [captureId],
              )
              .catch(() => undefined);
          }
          for (const response of result) await write(client, response);
          accepted = [];
          captureId = undefined;
          continue;
        }
        const status = await sendCommand(line);
        if (command === "QUIT" || command === "STARTTLS" || status >= 400)
          break;
      }
    } catch {
      if (!client.destroyed) {
        await write(
          client,
          "451 4.3.0 Temporary local processing failure\r\n",
        ).catch(() => undefined);
      }
    } finally {
      client.destroy();
      upstream.destroy();
    }
  };
  return createServer((client) => void handle(client));
}

export function rewriteMailpitMarker(data: Buffer, captureId: string): Buffer {
  if (!/^[0-9a-f-]{36}$/.test(captureId))
    throw new Error("Invalid capture id.");
  return rewriteData(data, captureId);
}
