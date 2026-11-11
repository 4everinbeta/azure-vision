import type { FastifyInstance } from "fastify";

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: "Internal error" });
  });
}
