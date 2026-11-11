import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { extractEdges, type Inventory } from "@azure-vision/shared";
import { config } from "../config";
import { type Access, resolveAccess } from "../access";
import { HttpError } from "../http";
import { argSource, queryInventory } from "../sources/arg";
import { managedSource } from "../sources/managed";
import { mockSource } from "../sources/mock";
import * as localAuth from "../localAuth";
import { LoginRejected } from "../sessions";
import { getStore } from "../store";
import { indexInventory, searchEnabled, searchResources } from "../search";

const source = config.source === "arg" ? argSource : config.source === "managed" ? managedSource : mockSource;
const principalName = (req: { headers: Record<string, unknown> }) => req.headers["x-ms-client-principal-name"] as string | undefined;

export async function loadInventory(access: Access, refresh: boolean, log: FastifyBaseLogger): Promise<Inventory> {
  const store = await getStore();
  if (!refresh) {
    const hit = await store.get<Inventory>(access.cacheKey, config.cacheTtlMs);
    // Edges are derived data: recompute so cached snapshots pick up new extractors.
    if (hit) return { ...hit, edges: extractEdges(hit.resources) };
  }
  try {
    const inv = config.source === "local" ? await queryInventory(access.token!) : await source.fetchInventory(access.token);
    await store.put(access.cacheKey, inv);
    indexInventory(inv, access.cacheKey, log);
    return inv;
  } catch (e) {
    log.error(e);
    throw new HttpError(502, (e as Error).message);
  }
}

export function registerInventory(app: FastifyInstance) {
  app.get("/api/config", async (req) => ({
    source: config.source,
    user: principalName(req),
    tenantId: config.tenantId,
    clientId: config.clientId,
    search: searchEnabled(),
  }));

  app.get("/api/auth/status", async (req) => localAuth.status(req));
  app.post("/api/auth/login", async (req, reply) => {
    try {
      return localAuth.startLogin(req, reply);
    } catch (e) {
      if (e instanceof LoginRejected) throw new HttpError(e.status, e.message);
      throw e;
    }
  });
  app.post("/api/auth/logout", async (req, reply) => {
    localAuth.logout(req, reply);
    return { signedIn: false };
  });
  // Used by the web gateway (nginx auth_request, which forwards the browser's cookie) to pass the session's token on.
  app.get("/internal/token", async (req, reply) => {
    const token = config.source === "local" ? await localAuth.getArmToken(req) : undefined;
    return token ? reply.code(204).header("x-arm-token", token).send() : reply.code(config.source === "local" ? 401 : 204).send();
  });

  app.get("/api/inventory", async (req, reply) => {
    const access = await resolveAccess(req, reply);
    if (!access) return;
    return loadInventory(access, (req.query as { refresh?: string }).refresh === "1", req.log);
  });

  app.get("/api/search", async (req, reply) => {
    if (!searchEnabled()) throw new HttpError(501, "Search is not configured (set ELASTICSEARCH_URL)");
    const access = await resolveAccess(req, reply);
    if (!access) return;
    const q = String((req.query as { q?: string }).q ?? "").slice(0, 200);
    try {
      return await searchResources(access.cacheKey, q);
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
  });
}
