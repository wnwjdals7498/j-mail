import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { Pool } from "pg";
import { createApp } from "../../apps/server/src/app.js";
import { loadDatabaseConfig } from "../../apps/server/src/config.js";
import { migrate } from "../../apps/server/src/db/migrate.js";
import { createCapture } from "./capture.js";
import { authorizationCodeLogin } from "./oidc-code.js";
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Actual integration requires ${name}. No skip.`);
  return value;
};
export async function integrationRuntime() {
  if (
    required("JML_TEST_RUNTIME") !== "isolated-cloud" ||
    required("JAUTH_TEST_RUNTIME") !== "isolated-cloud" ||
    new URL(required("KC_PUBLIC_URL")).hostname !== "auth.jgw.test"
  )
    throw new Error("Isolated fixtures required.");
  const cert = await readFile(required("JML_TLS_CERTIFICATE")),
    key = await readFile(required("JML_TLS_KEY"));
  const agent = new Agent({
    connect: {
      ca: [cert, await readFile(required("JAUTH_TLS_CERTIFICATE"))],
      lookup: (host, options, callback) => {
        if (
          ["auth.jgw.test", "jauth.jgw.test", "mail.jgw.test"].includes(host)
        ) {
          if (options.all)
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        } else lookup(host, options, callback);
      },
    },
  });
  const fetch: typeof globalThis.fetch = async (input, init) =>
    (await undiciFetch(String(input), {
      ...init,
      dispatcher: agent,
      redirect: init?.redirect ?? "error",
      signal: init?.signal ?? AbortSignal.timeout(10000),
    } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  const pool = new Pool(loadDatabaseConfig()),
    apps: ReturnType<typeof createApp>[] = [],
    children: ReturnType<typeof spawn>[] = [],
    secrets = new Set<string>(),
    logs: string[] = [];
  const fixtures: {
    tenant: string;
    password: string;
    clientSecret: string;
    serviceKey: string;
  }[] = [];
  const authPool = new Pool({
    host: "127.0.0.1",
    port: 54230,
    database: "jauth",
    user: "jauth",
    password: required("JAUTH_DB_PASSWORD"),
  });
  let master = "";
  const kcAdmin = (path: string, method = "GET") =>
    fetch(required("KC_PUBLIC_URL") + path, {
      method,
      headers: { Authorization: `Bearer ${master}` },
    });
  let admin = "",
    capture: Awaited<ReturnType<typeof createCapture>> | undefined;
  const auth = (path: string, method = "GET", body?: unknown) =>
    fetch("https://jauth.jgw.test:54231" + path, {
      method,
      headers: {
        Authorization: `Bearer ${admin}`,
        "X-JGW-Service-Key": fixtures[0]!.serviceKey,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    timer.unref();
    try {
      await done;
    } finally {
      clearTimeout(timer);
    }
  };
  const start = async (
    cwd: string,
    args: string[],
    url: string,
    env: NodeJS.ProcessEnv = process.env,
  ) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    child.stdout?.on("data", (b: Buffer) => logs.push(b.toString()));
    child.stderr?.on("data", (b: Buffer) => logs.push(b.toString()));
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Compiled fixture stopped.");
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(300) })).ok)
          return child;
      } catch {
        /* bounded readiness */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Compiled fixture not ready.");
  };
  const token = async (
    tenant: string,
    username: string,
    password: string,
    exchange = true,
  ) => {
    const fixture = fixtures.find((f) => f.tenant === tenant);
    if (!fixture) throw new Error("Unknown fixture owner.");
    const endpoint =
        required("KC_PUBLIC_URL") +
        "/realms/tenant-" +
        tenant +
        "/protocol/openid-connect/token",
      credentials = {
        client_id: "j-groupware",
        client_secret: fixture.clientSecret,
      };
    const original = (
      await authorizationCodeLogin(
        { publicUrl: required("KC_PUBLIC_URL"), fetch },
        {
          tenantId: tenant,
          username,
          password,
          clientSecret: fixture.clientSecret,
        },
      )
    ).access_token;
    secrets.add(original);
    if (!exchange) return original;
    const reduced = await fetch(endpoint, {
      method: "POST",
      body: new URLSearchParams({
        ...credentials,
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: original,
        subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        audience: "j-mail",
      }),
    });
    if (!reduced.ok)
      throw new Error(`Fixture mail exchange failed (${reduced.status}).`);
    const result = ((await reduced.json()) as { access_token: string })
      .access_token;
    secrets.add(result);
    return result;
  };
  const close = async () => {
    try {
      for (const app of apps.reverse()) await app.close();
      for (const f of fixtures) {
        const response = await kcAdmin(
          "/admin/realms/tenant-" + f.tenant,
          "DELETE",
        );
        if (![204, 404].includes(response.status))
          throw new Error("Owned fixture realm cleanup failed.");
        await authPool.query("DELETE FROM tenants WHERE tenant_id=$1", [
          f.tenant,
        ]);
      }
    } finally {
      await capture?.close();
      for (const child of children.reverse()) await stop(child);
      await pool.end();
      await authPool.end();
      await agent.close();
    }
  };
  const newApp = async (
    tenant: string,
    port = 0,
    overrides: Partial<Parameters<typeof createApp>[0]> = {},
  ) => {
    const app = createApp({
      pool,
      tenant,
      keycloakOrigin: required("KC_PUBLIC_URL"),
      mailpitOrigin: capture!.origin,
      fetch,
      https: { cert, key },
      ...overrides,
    });
    apps.push(app);
    await app.listen({ host: "127.0.0.1", port });
    const a = app.server.address();
    if (!a || typeof a === "string") throw new Error("Fixture bind failed.");
    return a.port;
  };
  const request = (
    path: string,
    bearer: string,
    port = 54310,
    headers: Record<string, string> = {},
  ) =>
    fetch(`https://mail.jgw.test:${port}${path}`, {
      headers: { Authorization: `Bearer ${bearer}`, ...headers },
    });
  try {
    await migrate(pool);
    const authRoot = fileURLToPath(
      new URL("../../../j-auth/", import.meta.url),
    );
    await start(
      authRoot,
      [
        `--env-file=${required("JAUTH_TEST_ENV")}`,
        "--import",
        authRoot + "tests/integration/resolve-test-hosts.mjs",
        "apps/server/dist/main.js",
      ],
      "https://jauth.jgw.test:54231/health/ready",
    );
    const bootstrap = await fetch(
      required("KC_PUBLIC_URL") +
        "/realms/master/protocol/openid-connect/token",
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: "admin-cli",
          grant_type: "password",
          username: required("KC_BOOTSTRAP_ADMIN_USERNAME"),
          password: required("KC_BOOTSTRAP_ADMIN_PASSWORD"),
        }),
      },
    );
    if (!bootstrap.ok) throw new Error("Fixture bootstrap failed.");
    master = ((await bootstrap.json()) as { access_token: string })
      .access_token;
    secrets.add(master);
    const login = await fetch(
      required("KC_PUBLIC_URL") +
        "/realms/operator/protocol/openid-connect/token",
      {
        method: "POST",
        body: new URLSearchParams({
          client_id: "j-console",
          client_secret: required("JGW_OPERATOR_J_CONSOLE_CLIENT_SECRET"),
          grant_type: "password",
          username: "op-admin",
          password: required("JGW_OPERATOR_OP_ADMIN_PASSWORD"),
          scope: "openid",
        }),
      },
    );
    if (!login.ok) throw new Error("Fixture operator failed.");
    const operator = ((await login.json()) as { access_token: string })
      .access_token;
    secrets.add(operator);
    for (const label of ["a", "b"]) {
      const tenant = "mail-" + label + "-" + randomUUID().slice(0, 8),
        password = randomBytes(24).toString("base64url");
      if (
        (
          await authPool.query("SELECT 1 FROM tenants WHERE tenant_id=$1", [
            tenant,
          ])
        ).rowCount ||
        (await kcAdmin("/admin/realms/tenant-" + tenant)).status !== 404
      )
        throw new Error("Existing fixture preserved.");
      const headers = {
        Authorization: "Bearer " + operator,
        "X-JGW-Service-Key": required("JAUTH_CONSOLE_SERVICE_KEY"),
        "Content-Type": "application/json",
      };
      const created = await fetch("https://jauth.jgw.test:54231/auth/tenants", {
        method: "POST",
        headers,
        body: JSON.stringify({
          tenantId: tenant,
          adminUsername: "owner",
          adminPassword: password,
        }),
      });
      if (created.status !== 201)
        throw new Error(`Owned tenant creation failed (${created.status}).`);
      const credentials = (await created.json()) as {
        clientSecret: string;
        serviceKey: string;
      };
      fixtures.push({ tenant, password, ...credentials });
      for (const secret of [
        password,
        credentials.clientSecret,
        credentials.serviceKey,
      ])
        secrets.add(secret);
      const sub = await fetch(
        `https://jauth.jgw.test:54231/auth/tenants/${tenant}/services/j-mail`,
        {
          method: "PUT",
          headers: {
            Authorization: headers.Authorization,
            "X-JGW-Service-Key": headers["X-JGW-Service-Key"],
          },
        },
      );
      if (sub.status !== 200)
        throw new Error(`Owned mail subscription failed (${sub.status}).`);
    }
    capture = await createCapture(
      fixtures[0]!.tenant,
      0,
      0,
      fixtures.map((f) => f.tenant),
    );
    admin = await token(
      fixtures[0]!.tenant,
      "owner",
      fixtures[0]!.password,
      false,
    );
    const actors: { id: string; token: string; original: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const username = `mail-${randomUUID()}`,
        password = randomBytes(24).toString("base64url");
      secrets.add(password);
      const created = await auth("/auth/members", "POST", {
        username,
        password,
        roles: i < 2 ? ["mail:read"] : [],
      });
      if (created.status !== 201)
        throw new Error(`Fixture member failed (${created.status}).`);
      const id = ((await created.json()) as { id: string }).id;
      actors.push({
        id,
        token: await token(fixtures[0]!.tenant, username, password),
        original: await token(fixtures[0]!.tenant, username, password, false),
      });
    }
    const foreign = await token(
      fixtures[1]!.tenant,
      "owner",
      fixtures[1]!.password,
    );
    await newApp(fixtures[0]!.tenant, 54310);
    await newApp(fixtures[1]!.tenant, 54314);
    const startCompiled = async () => {
      const env = fileURLToPath(
        new URL("../../../.suite-runtime/j-mail/compiled.env", import.meta.url),
      );
      await writeFile(
        env,
        (await readFile(required("JML_TEST_ENV"), "utf8")) +
          `\nJML_PORT=54316\nJML_TENANT=${fixtures[0]!.tenant}\nJML_MAILPIT_URL=${capture!.origin}\n`,
        { mode: 0o600 },
      );
      return start(
        fileURLToPath(new URL("../../", import.meta.url)),
        [
          `--env-file=${required("JAUTH_TEST_ENV")}`,
          `--env-file=${env}`,
          "--import",
          fileURLToPath(new URL("./resolve-test-hosts.mjs", import.meta.url)),
          "apps/server/dist/main.js",
        ],
        "https://mail.jgw.test:54316/health/ready",
        {
          ...process.env,
          JML_PORT: "54316",
          JML_TENANT: fixtures[0]!.tenant,
          JML_MAILPIT_URL: capture!.origin,
        },
      );
    };
    return {
      pool,
      fixtures,
      fetch,
      capture,
      actors,
      foreign,
      newApp,
      request,
      startCompiled,
      stop,
      secrets,
      logs,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
export type Runtime = Awaited<ReturnType<typeof integrationRuntime>>;
