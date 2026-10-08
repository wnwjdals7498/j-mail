import Fastify, { LogController } from "fastify";
import type { FastifyServerOptions, FastifyError } from "fastify";
import type { ServerOptions as HttpsOptions } from "node:https";
import type { Pool } from "pg";
import {
  createTokenVerifier,
  TokenVerificationError,
} from "@j-auth/token-verifier";
import type { TokenVerifier } from "@j-auth/token-verifier";
import { MAIL_PATHS, MAIL_LIMITS, MAIL_ID_PATTERN } from "@j-mail/contracts";
import { ApiError, unavailable, forbidden } from "./errors.js";
import { MailpitClient } from "./mailpit.js";
const ROUTES = new Set([
  "GET /health/live",
  "GET /health/ready",
  "GET /mail/messages",
  "GET /mail/messages/:id",
]);
export function createApp(options: {
  pool: Pool;
  tenant: string;
  keycloakOrigin: string;
  mailpitOrigin: string;
  verifier?: TokenVerifier;
  fetch?: typeof globalThis.fetch;
  mailpitFetch?: typeof globalThis.fetch;
  https?: HttpsOptions;
  logger?: FastifyServerOptions["logger"];
}) {
  const app = Fastify({
    exposeHeadRoutes: false,
    trustProxy: false,
    bodyLimit: 65536,
    ajv: { customOptions: { removeAdditional: false } },
    ...(options.https ? { https: options.https } : {}),
    logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const verifier =
    options.verifier ??
    createTokenVerifier({
      publicUrl: options.keycloakOrigin,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  const mail = new MailpitClient(
    options.mailpitOrigin,
    options.tenant,
    options.mailpitFetch,
  );
  app.addHook("onRoute", (route) => {
    if (!ROUTES.has(`${route.method} ${route.url}`))
      throw new Error("Route must declare mail access.");
    if (route.url.startsWith("/health/")) return;
    route.onRequest = async (request) => {
      const auth = request.headers.authorization;
      if (
        !auth ||
        !/^Bearer [^\s]+$/.test(auth) ||
        auth.length > 16400 ||
        request.headers.cookie !== undefined
      )
        throw new ApiError(401, "unauthenticated", "Valid bearer required.");
      try {
        const identity = await verifier.verify(auth.slice(7), {
            tenantId: options.tenant,
            audience: "j-mail",
          }),
          aud = identity.claims.aud;
        if (
          !(
            aud === "j-mail" ||
            (Array.isArray(aud) && aud.length === 1 && aud[0] === "j-mail")
          ) ||
          typeof identity.claims.sid !== "string" ||
          !identity.claims.sid ||
          typeof identity.claims.preferred_username !== "string" ||
          !identity.claims.preferred_username ||
          identity.claims.preferred_username.startsWith("service-account-")
        )
          throw new ApiError(
            401,
            "unauthenticated",
            "Invalid bearer identity.",
          );
        if (!identity.roles.includes("mail:read")) throw forbidden();
      } catch (e) {
        if (e instanceof ApiError) throw e;
        if (e instanceof TokenVerificationError && e.kind === "invalid")
          throw new ApiError(
            401,
            "unauthenticated",
            "Invalid bearer identity.",
          );
        throw unavailable();
      }
    };
  });
  app.addHook("onRequest", async (_request, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
  });
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const safe =
      error instanceof ApiError
        ? error
        : "validation" in error ||
            [400, 413, 415].includes(Number(error.statusCode))
          ? new ApiError(
              Number(error.statusCode ?? 400),
              "invalid_input",
              "Invalid request.",
            )
          : unavailable();
    if (safe.status === 503)
      request.log.warn(
        { code: safe.code, requestId: request.id },
        "Mail request unavailable",
      );
    reply
      .code(safe.status)
      .send({ code: safe.code, message: safe.message, requestId: request.id });
  });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await options.pool.query("SELECT 1");
    return { status: "ok" };
  });
  app.get<{ Querystring: { offset: number; limit: number } }>(
    MAIL_PATHS.messages,
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            offset: {
              type: "integer",
              minimum: 0,
              maximum: MAIL_LIMITS.scan,
              default: 0,
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAIL_LIMITS.page,
              default: 20,
            },
          },
        },
      },
    },
    (request) => mail.list(request.query.offset, request.query.limit),
  );
  app.get<{ Params: { id: string } }>(
    "/mail/messages/:id",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["id"],
          properties: { id: { type: "string", pattern: MAIL_ID_PATTERN } },
        },
        querystring: { type: "object", additionalProperties: false },
      },
    },
    (request) => mail.detail(request.params.id),
  );
  return app;
}
