import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PoolConfig } from "pg";
import { assertCustomerTenantId } from "@j-auth/contracts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.startsWith("__PLACEHOLDER_"))
    throw new Error("Set external mail configuration.");
  return value;
}
export function port(value: string): number {
  const parsed = Number(value);
  if (!/^[1-9][0-9]*$/.test(value) || parsed > 65535 || parsed === 3001)
    throw new Error("Invalid or reserved port.");
  return parsed;
}
export function externalFile(value: string): string {
  if (
    !path.isAbsolute(value) ||
    !path.relative(repository, value).startsWith(".." + path.sep)
  )
    throw new Error("Require a file outside checkout.");
  return value;
}
export function mailpitOrigin(value: string): string {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.port === "3001" ||
    u.pathname !== "/" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error("Mailpit requires an explicit loopback HTTP origin.");
  return u.origin;
}
export function loadDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  if (
    (env.JML_DB_NAME && env.JML_DB_NAME !== "jgw_mail") ||
    (env.JML_DB_USER && env.JML_DB_USER !== "jgw_mail")
  )
    throw new Error("Require dedicated jgw_mail database and non-superuser.");
  return {
    host: env.JML_DB_HOST ?? "127.0.0.1",
    port: port(env.JML_DB_PORT ?? "54308"),
    database: "jgw_mail",
    user: "jgw_mail",
    password: required(env, "JML_DB_PASSWORD"),
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    application_name: "j-mail",
  };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const tenant = required(env, "JML_TENANT");
  assertCustomerTenantId(tenant);
  const issuer = new URL(required(env, "KC_PUBLIC_URL"));
  if (
    issuer.protocol !== "https:" ||
    !issuer.hostname.endsWith(".jgw.test") ||
    issuer.port === "3001" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname !== "/"
  )
    throw new Error("Require registered Keycloak HTTPS origin.");
  return {
    tenant,
    keycloakOrigin: issuer.origin,
    port: port(env.JML_PORT ?? "54310"),
    tlsCertificate: externalFile(required(env, "JML_TLS_CERTIFICATE")),
    tlsKey: externalFile(required(env, "JML_TLS_KEY")),
    database: loadDatabaseConfig(env),
    mailpitOrigin: mailpitOrigin(required(env, "JML_MAILPIT_URL")),
  };
}
