import { randomBytes } from "node:crypto";
import { decodeJwt } from "jose";

export interface AuthStatus {
  signedIn: boolean;
  user?: string;
  pending?: { userCode: string; verificationUri: string };
  error?: string;
}

export interface TokenSource {
  getToken(scope: string, options?: { abortSignal?: AbortSignal }): Promise<{ token: string } | null>;
}
export type CredentialFactory = (onPrompt: (p: { userCode: string; verificationUri: string }) => void) => TokenSource;

export interface SessionLimits {
  idleMs: number;
  maxSessions: number;
  maxPending: number;
  /** Device-code flows a single client IP may start per window. */
  loginsPerIp: number;
  loginWindowMs: number;
  /** When set, only accounts whose token carries this tenant id are accepted. */
  tenantId?: string;
}

export class LoginRejected extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface Session {
  lastSeen: number;
  credential?: TokenSource;
  pending?: AuthStatus["pending"];
  signingIn?: AbortController;
  error?: string;
  user?: string;
  key?: string;
}

/** Independent device-code sign-ins, one per browser session id. Tokens are held in memory only. */
export class DeviceSessions {
  private sessions = new Map<string, Session>();
  private logins = new Map<string, number[]>();

  constructor(
    private scope: string,
    private factory: CredentialFactory,
    private limits: SessionLimits,
    private now: () => number = Date.now,
  ) {}

  static newId = () => randomBytes(32).toString("base64url");

  private get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.now() - s.lastSeen > this.limits.idleMs) {
      this.drop(id);
      return undefined;
    }
    s.lastSeen = this.now();
    return s;
  }

  private drop(id: string) {
    this.sessions.get(id)?.signingIn?.abort();
    this.sessions.delete(id);
  }

  get size() { return this.sessions.size; }

  has(id: string) { return !!this.get(id); }

  status(id: string | undefined): AuthStatus {
    const s = this.get(id);
    if (!s) return { signedIn: false };
    return { signedIn: !!s.user, user: s.user, pending: s.user ? undefined : s.pending, error: s.error };
  }

  /** Starts (or reports) a device-code flow for the session `id`, creating the session if needed. */
  startLogin(id: string, ip: string): AuthStatus {
    let s = this.get(id);
    if (s?.user || s?.signingIn) return this.status(id);
    this.sweep();
    if (!s && this.sessions.size >= this.limits.maxSessions) throw new LoginRejected(503, "Too many active sessions; try again later");
    const pendingCount = [...this.sessions.values()].filter((x) => x.signingIn).length;
    if (pendingCount >= this.limits.maxPending) throw new LoginRejected(503, "Too many sign-ins in progress; try again shortly");
    const t = this.now();
    const recent = (this.logins.get(ip) ?? []).filter((at) => t - at < this.limits.loginWindowMs);
    if (recent.length >= this.limits.loginsPerIp) throw new LoginRejected(429, "Too many sign-in attempts; try again later");
    recent.push(t);
    this.logins.set(ip, recent);

    if (!s) {
      s = { lastSeen: t };
      this.sessions.set(id, s);
    }
    const session = s;
    session.error = undefined;
    session.pending = undefined;
    const abort = new AbortController();
    session.signingIn = abort;
    const cred = this.factory((p) => { session.pending = p; });
    cred
      .getToken(this.scope, { abortSignal: abort.signal })
      .then((tok) => {
        if (abort.signal.aborted) return;
        if (!tok) throw new Error("No token returned");
        const c = decodeJwt(tok.token);
        if (this.limits.tenantId && String(c.tid).toLowerCase() !== this.limits.tenantId.toLowerCase()) {
          throw new Error("This account belongs to a different tenant than the one this app is restricted to");
        }
        session.credential = cred;
        session.key = `local:${c.tid}:${c.oid}`;
        session.user = String(c.upn ?? c.unique_name ?? c.preferred_username ?? c.name ?? "signed in");
      })
      .catch((e: Error) => { if (!abort.signal.aborted) session.error = e.message; })
      .finally(() => {
        if (session.signingIn === abort) session.signingIn = undefined;
        session.pending = undefined;
      });
    return this.status(id);
  }

  logout(id: string | undefined) {
    if (id) this.drop(id);
  }

  /** Stable per-identity cache key (tenant + object id), shared by all sessions of the same user. */
  key(id: string | undefined) { return this.get(id)?.key; }

  async token(id: string | undefined): Promise<string | undefined> {
    const s = this.get(id);
    if (!s?.credential) return undefined;
    try {
      return (await s.credential.getToken(this.scope))?.token;
    } catch {
      // Refresh failed (expired/revoked): force a fresh sign-in.
      s.credential = s.user = s.key = undefined;
      return undefined;
    }
  }

  sweep() {
    const t = this.now();
    for (const [id, s] of this.sessions) if (t - s.lastSeen > this.limits.idleMs) this.drop(id);
    for (const [ip, times] of this.logins) {
      const recent = times.filter((at) => t - at < this.limits.loginWindowMs);
      if (recent.length) this.logins.set(ip, recent);
      else this.logins.delete(ip);
    }
  }
}
