import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyArmToken } from "./armToken";
import { config } from "./config";
import { verifyToken } from "./auth";
import * as localAuth from "./localAuth";

export interface Access { token?: string; cacheKey: string }

const bearer = (req: FastifyRequest) => req.headers.authorization?.replace(/^Bearer /i, "") || undefined;

/**
 * Authenticates the request for the current SOURCE; replies 401 and returns undefined on failure.
 * In local mode a forwarded bearer token (set by the web gateway) is used if present, so services other than
 * the one holding the device-code session stay stateless; ARM validates the token on every call.
 */
export async function resolveAccess(req: FastifyRequest, reply: FastifyReply): Promise<Access | undefined> {
  if (config.source === "local") {
    const forwarded = bearer(req);
    if (forwarded) {
      // Service-to-service: only trust identity claims once the token is verified (it is also re-validated by ARM).
      try {
        const c = await verifyArmToken(forwarded, { tenantId: config.tenantId || undefined });
        return { token: forwarded, cacheKey: `local:${c.tid}:${c.oid}` };
      } catch (e) {
        req.log.warn(`rejected forwarded token: ${(e as Error).message}`);
        return void reply.code(401).send({ error: "Invalid token" });
      }
    }
    const token = await localAuth.getArmToken(req);
    const cacheKey = localAuth.userKey(req);
    if (!token || !cacheKey) return void reply.code(401).send({ error: "Not signed in" });
    return { token, cacheKey };
  }
  if (config.source === "managed") {
    // Easy Auth has already authenticated the caller; this is defence in depth against direct access.
    if (config.requireEasyAuth && !req.headers["x-ms-client-principal-id"]) {
      return void reply.code(401).send({ error: "Not signed in" });
    }
    return { cacheKey: "managed" }; // everyone sees the managed identity's view
  }
  if (config.source === "arg") {
    const token = bearer(req);
    if (!token) return void reply.code(401).send({ error: "Missing bearer token" });
    try {
      const claims = await verifyToken(token);
      return { token, cacheKey: `arg:${claims.tid}:${claims.oid ?? claims.sub}` }; // per user: results are RBAC-scoped
    } catch {
      return void reply.code(401).send({ error: "Invalid token" });
    }
  }
  return { cacheKey: "mock" };
}
