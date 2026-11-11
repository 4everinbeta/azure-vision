import { DeviceCodeCredential } from "@azure/identity";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config";
import { ARM_SCOPE } from "./sources/arg";
import { type AuthStatus, DeviceSessions } from "./sessions";

export type { AuthStatus } from "./sessions";

// Per-browser device-code sign-in: each browser gets its own session (random id in an httpOnly cookie).
const COOKIE = "av_sid";

export const sessions = new DeviceSessions(
  ARM_SCOPE,
  (onPrompt) =>
    new DeviceCodeCredential({
      tenantId: config.tenantId || "organizations",
      clientId: config.clientId || undefined, // defaults to Azure's public developer sign-on app
      userPromptCallback: (info) => onPrompt({ userCode: info.userCode, verificationUri: info.verificationUri }),
    }),
  {
    idleMs: config.sessionIdleMs,
    maxSessions: config.maxSessions,
    maxPending: config.maxPendingLogins,
    loginsPerIp: config.loginsPerIp,
    loginWindowMs: 10 * 60 * 1000,
    tenantId: config.tenantId || undefined,
  },
);
setInterval(() => sessions.sweep(), 5 * 60 * 1000).unref();

export function sessionId(req: FastifyRequest): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === COOKIE && v && /^[A-Za-z0-9_-]{20,100}$/.test(v)) return v;
  }
  return undefined;
}

function setCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) {
  const secure = req.headers["x-forwarded-proto"] === "https" || req.protocol === "https" ? "; Secure" : "";
  reply.header("set-cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

export const status = (req: FastifyRequest): AuthStatus => sessions.status(sessionId(req));

export function startLogin(req: FastifyRequest, reply: FastifyReply): AuthStatus {
  // Never adopt an unknown client-chosen id (session fixation); mint one instead.
  const current = sessionId(req);
  const id = current && sessions.has(current) ? current : DeviceSessions.newId();
  const forwardedIp = config.clientIpHeader ? String(req.headers[config.clientIpHeader] ?? "").slice(0, 64) : "";
  const result = sessions.startLogin(id, forwardedIp || req.ip);
  setCookie(req, reply, id, Math.floor(config.sessionIdleMs / 1000));
  return result;
}

export function logout(req: FastifyRequest, reply: FastifyReply) {
  sessions.logout(sessionId(req));
  setCookie(req, reply, "", 0);
}

export const userKey = (req: FastifyRequest) => sessions.key(sessionId(req));
export const getArmToken = (req: FastifyRequest) => sessions.token(sessionId(req));
