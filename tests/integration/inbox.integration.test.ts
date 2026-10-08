import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { decodeJwt } from "jose";
import { MAIL_PATHS, parseMailPage, parseMailDetail } from "@j-mail/contracts";
import { integrationRuntime } from "./runtime.js";
import type { Runtime } from "./runtime.js";
describe("actual Mailpit inbox, j-auth members, reduced Keycloak JWT and loopback HTTPS", () => {
  let r: Runtime;
  const own: string[] = [],
    other: string[] = [];
  beforeAll(async () => {
    r = await integrationRuntime();
    for (let i = 0; i < 6; i++)
      await r.capture.send(
        [`member@${r.fixtures[i % 2]!.tenant}.jgw.test`],
        `From: sender@${r.fixtures[0]!.tenant}.jgw.test\r\nTo: forged@${r.fixtures[(i + 1) % 2]!.tenant}.jgw.test\r\nSubject: mixed-${i}\r\nContent-Type: text/html`,
        "<script>globalThis.mailUnsafe=true</script><p>isolated body</p>",
      );
    const native = (await r.capture.api("/api/v1/messages")) as {
      messages: { ID: string; Subject: string }[];
    };
    for (const m of native.messages)
      (Number(m.Subject.slice(-1)) % 2 ? other : own).push(m.ID);
  });
  afterAll(async () => {
    await r?.close();
  });
  it("actually exchanges single j-mail audience and preserves member session claims", () => {
    for (const actor of r.actors) {
      const claims = decodeJwt(actor.token);
      expect(claims.aud).toBe("j-mail");
      expect(claims.tenant).toBe(r.fixtures[0]!.tenant);
      expect(claims.sid).toBeTypeOf("string");
      expect(claims.azp).toBe("j-groupware");
    }
  });
  it("filters mixed tenants before total and page boundaries despite forged To", async () => {
    for (let offset = 0; offset <= 3; offset++) {
      const response = await r.request(
        `/mail/messages?offset=${offset}&limit=1`,
        r.actors[0]!.token,
      );
      expect(response.status).toBe(200);
      const page = parseMailPage(await response.json());
      expect(page.total).toBe(3);
      expect(page.items.map((m) => m.id)).toEqual(
        own.slice(offset, offset + 1),
      );
      expect(JSON.stringify(page)).not.toContain(other[0]);
    }
    const foreign = await r.request(
      "/mail/messages?limit=100",
      r.foreign,
      54314,
    );
    expect(foreign.status).toBe(200);
    expect(parseMailPage(await foreign.json()).items.map((m) => m.id)).toEqual(
      other,
    );
  });
  it("shares the inbox between two actual same-tenant members", async () => {
    const pages = await Promise.all(
      r.actors
        .slice(0, 2)
        .map(async (a) =>
          parseMailPage(
            await (await r.request(MAIL_PATHS.messages, a.token)).json(),
          ),
        ),
    );
    expect(pages[0]).toEqual(pages[1]);
  });
  it("returns typed headers/text/untrusted HTML without evaluating it or exposing native fields", async () => {
    const response = await r.request(
      MAIL_PATHS.message(own[0]!),
      r.actors[0]!.token,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json(),
      detail = parseMailDetail(data);
    expect(detail.html).toContain("<script>");
    expect(detail.headers.Received![0]).toContain(
      r.fixtures[0]!.tenant + ".jgw.test",
    );
    expect(data).not.toHaveProperty("Read");
    expect(data).not.toHaveProperty("Attachments");
  });
  it("rejects another tenant id without marking its native Read flag", async () => {
    const id = other[0]!;
    const before = (await r.capture.api("/api/v1/messages")) as {
      messages: { ID: string; Read: boolean }[];
    };
    expect(before.messages.find((m) => m.ID === id)!.Read).toBe(false);
    const denied = await r.request(MAIL_PATHS.message(id), r.actors[0]!.token);
    expect(denied.status).toBe(404);
    expect(await denied.text()).not.toContain("mixed-");
    const after = (await r.capture.api("/api/v1/messages")) as typeof before;
    expect(after.messages.find((m) => m.ID === id)!.Read).toBe(false);
    expect(
      (await r.request(MAIL_PATHS.message("Z".repeat(22)), r.actors[0]!.token))
        .status,
    ).toBe(404);
  });
  it("returns actual 401 for malformed, foreign tenant, unreduced audience, cookie and signature corruption", async () => {
    for (const token of [
      "invalid",
      r.foreign,
      r.actors[0]!.original,
      r.actors[0]!.token.slice(0, -10) + "AAAAAAAAAA",
    ]) {
      expect((await r.request(MAIL_PATHS.messages, token)).status).toBe(401);
    }
    expect(
      (
        await r.request(MAIL_PATHS.messages, r.actors[0]!.token, 54310, {
          Cookie: "unrelated=1",
        })
      ).status,
    ).toBe(401);
    const missing = await r.fetch("https://mail.jgw.test:54310/mail/messages");
    expect(missing.status).toBe(401);
  });
  it("returns actual 403 for a created member lacking mail:read", async () => {
    expect(
      (await r.request(MAIL_PATHS.messages, r.actors[2]!.token)).status,
    ).toBe(403);
  });
  it("rejects tenant/source injection, bad pagination/id and leaves unregistered endpoints inaccessible", async () => {
    for (const path of [
      "/mail/messages?tenant=sample-b",
      "/mail/messages?url=http://example.invalid",
      "/mail/messages?offset=-1",
      "/mail/messages?limit=101",
      "/mail/messages?offset=1001",
      "/mail/messages/invalid",
      "/mail/messages/" + own[0] + "?tenant=sample-b",
    ])
      expect((await r.request(path, r.actors[0]!.token)).status).toBe(400);
    expect(
      (await r.request("/api/v1/messages", r.actors[0]!.token)).status,
    ).toBe(404);
  });
  it("returns 503 during actual Mailpit stop and recovers after restart", async () => {
    r.capture.stopped();
    try {
      const response = await r.request(MAIL_PATHS.messages, r.actors[0]!.token);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("mixed-");
    } finally {
      await r.capture.start();
    }
    expect(
      (await r.request(MAIL_PATHS.messages, r.actors[0]!.token)).status,
    ).toBe(200);
  });
  it("returns 503 when a fresh JWKS verifier cannot reach its real endpoint", async () => {
    const brokenFetch: typeof fetch = async (input, init) =>
      r.fetch(
        String(input).replace("auth.jgw.test:58443", "127.0.0.1:59997"),
        init,
      );
    const port = await r.newApp(r.fixtures[0]!.tenant, 0, {
      fetch: brokenFetch,
    });
    expect(
      (await r.request(MAIL_PATHS.messages, r.actors[0]!.token, port)).status,
    ).toBe(503);
  });
  it("starts the compiled loopback HTTPS entry and retains messages across service restart", async () => {
    let child = await r.startCompiled();
    try {
      expect(
        (
          await r.request(
            MAIL_PATHS.message(own[0]!),
            r.actors[0]!.token,
            54316,
          )
        ).status,
      ).toBe(200);
    } finally {
      await r.stop(child);
    }
    child = await r.startCompiled();
    try {
      expect(
        parseMailPage(
          await (
            await r.request(MAIL_PATHS.messages, r.actors[0]!.token, 54316)
          ).json(),
        ).items.map((m) => m.id),
      ).toEqual(own);
    } finally {
      await r.stop(child);
    }
  });
  it("does not emit member passwords, JWTs, mail bodies or subjects into service logs", () => {
    const text = r.logs.join("");
    for (const secret of r.secrets) expect(text).not.toContain(secret);
    expect(text).not.toContain("isolated body");
    expect(text).not.toContain("mixed-");
  });
});
