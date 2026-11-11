import type { FastifyInstance } from "fastify";
import { HttpError } from "../http";
import { computeLayout, type LayoutRequest } from "../layout";

const MAX_NODES = 5000;

export function registerLayout(app: FastifyInstance) {
  app.post("/api/layout", async (req) => {
    const b = req.body as Partial<LayoutRequest> | undefined;
    if (!b || !Array.isArray(b.nodes) || !Array.isArray(b.edges)) throw new HttpError(400, "nodes and edges are required");
    if (b.nodes.length > MAX_NODES) throw new HttpError(413, `At most ${MAX_NODES} nodes`);
    if (!b.nodes.every((n) => typeof n?.id === "string" && n.width > 0 && n.height > 0)) throw new HttpError(400, "Invalid node");
    return { positions: await computeLayout({ nodes: b.nodes, edges: b.edges }) };
  });
}
