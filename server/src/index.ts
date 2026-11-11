import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "./config";
import { installErrorHandler } from "./http";

// One codebase, several deployables: SERVICE selects which APIs this process serves ("all" = everything, for dev).
const svc = config.service;
const app = Fastify({ logger: true });
await app.register(cors, { origin: config.webOrigin });
installErrorHandler(app);

app.get("/api/health", async () => ({ ok: true, service: svc, source: config.source }));

if (svc === "all" || svc === "inventory") (await import("./services/inventory")).registerInventory(app);
if (svc === "all" || svc === "cost") (await import("./services/cost")).registerCost(app);
if (svc === "all" || svc === "layout") (await import("./services/layout")).registerLayout(app);

// In the single-process container the built SPA is served by this server.
if (config.webDist && existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: resolve(config.webDist) });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html"),
  );
}

await app.listen({ port: config.port, host: config.host });
