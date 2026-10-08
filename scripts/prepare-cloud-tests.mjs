import { mkdir, writeFile, access, chmod } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = path.resolve(repository, "../.suite-runtime/j-mail");
await mkdir(root, { recursive: true, mode: 0o700 });
try {
  await access(root + "/integration.env");
  throw new Error("Existing mail runtime preserved.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(root + "/tls", { mode: 0o700 });
await mkdir(root + "/postgres", { mode: 0o777 });
await chmod(root + "/postgres", 0o777);
const certificate = root + "/tls/mail.crt",
  key = root + "/tls/mail.key";
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:3072",
    "-sha256",
    "-nodes",
    "-days",
    "30",
    "-subj",
    "/CN=mail.jgw.test",
    "-addext",
    "subjectAltName=DNS:mail.jgw.test,IP:127.0.0.1",
    "-keyout",
    key,
    "-out",
    certificate,
  ],
  { stdio: "ignore" },
);
const password = randomBytes(32).toString("base64url"),
  admin = randomBytes(32).toString("base64url");
const env = {
  JML_TEST_RUNTIME: "isolated-cloud",
  JML_DB_HOST: "127.0.0.1",
  JML_DB_PORT: "54308",
  JML_DB_NAME: "jgw_mail",
  JML_DB_USER: "jgw_mail",
  JML_DB_PASSWORD: password,
  JML_TLS_CERTIFICATE: certificate,
  JML_TLS_KEY: key,
  JML_PORT: "54310",
  JML_MAILPIT_URL: "http://127.0.0.1:54311",
};
await writeFile(
  root + "/integration.env",
  Object.entries(env)
    .map(([k, v]) => `${k}=${v}\n`)
    .join(""),
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  root + "/compose.env",
  `POSTGRES_PASSWORD=${admin}\nJML_DB_PASSWORD=${password}\n`,
  { flag: "wx", mode: 0o600 },
);
await writeFile(
  root + "/compose.yaml",
  `services:\n  postgres:\n    image: postgres:18.6-bookworm\n    restart: "no"\n    ports: ["127.0.0.1:54308:5432"]\n    environment:\n      POSTGRES_USER: postgres\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?required}\n      JML_DB_PASSWORD: \${JML_DB_PASSWORD:?required}\n    volumes:\n      - ${root}/postgres:/var/lib/postgresql\n      - ${repository}/deploy/postgres-init.sh:/docker-entrypoint-initdb.d/010-mail.sh:ro\n    healthcheck:\n      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]\n      interval: 2s\n      timeout: 2s\n      retries: 30\n`,
  { flag: "wx", mode: 0o600 },
);
process.stdout.write(
  "Isolated mail PG/TLS fixture prepared outside checkout.\n",
);
