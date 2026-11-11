import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import { DeviceSessions, LoginRejected, type CredentialFactory } from "./sessions";
import { verifyArmToken } from "./armToken";

const TENANT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
const fakeJwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Credential whose sign-in completes when `finish(id)` is called with the given claims. */
function fakeCreds() {
  const resolvers: Array<(claims: Record<string, unknown>) => void> = [];
  let refreshFails = false;
  const factory: CredentialFactory = (onPrompt) => {
    let token: string | undefined;
    return {
      getToken: (_scope, opts) => {
        if (token) return refreshFails ? Promise.reject(new Error("expired")) : Promise.resolve({ token });
        onPrompt({ userCode: `CODE${resolvers.length}`, verificationUri: "https://microsoft.com/devicelogin" });
        return new Promise((resolve, reject) => {
          opts?.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")));
          resolvers.push((claims) => resolve({ token: (token = fakeJwt(claims)) }));
        });
      },
    };
  };
  return { factory, finish: (i: number, claims: Record<string, unknown>) => resolvers[i](claims), failRefresh: () => { refreshFails = true; } };
}

const limits = { idleMs: 1000, maxSessions: 3, maxPending: 2, loginsPerIp: 3, loginWindowMs: 10_000, tenantId: TENANT };

describe("DeviceSessions", () => {
  it("keeps browser sessions independent", async () => {
    const c = fakeCreds();
    const s = new DeviceSessions("scope", c.factory, limits);
    expect(s.startLogin("a", "ip").pending?.userCode).toBe("CODE0");
    expect(s.startLogin("b", "ip").pending?.userCode).toBe("CODE1");
    c.finish(0, { tid: TENANT, oid: "alice", upn: "alice@x" });
    await settle();
    expect(s.status("a")).toMatchObject({ signedIn: true, user: "alice@x" });
    expect(s.status("b")).toMatchObject({ signedIn: false, pending: { userCode: "CODE1" } });
    expect(s.key("a")).toBe(`local:${TENANT}:alice`);
    expect(s.key("b")).toBeUndefined();
    expect(await s.token("a")).toBeTruthy();
    expect(await s.token("b")).toBeUndefined();
    expect(await s.token(undefined)).toBeUndefined();
    s.logout("a");
    expect(s.status("a").signedIn).toBe(false);
    expect(await s.token("a")).toBeUndefined();
  });

  it("rejects accounts from other tenants", async () => {
    const c = fakeCreds();
    const s = new DeviceSessions("scope", c.factory, limits);
    s.startLogin("a", "ip");
    c.finish(0, { tid: OTHER, oid: "eve" });
    await settle();
    expect(s.status("a")).toMatchObject({ signedIn: false });
    expect(s.status("a").error).toMatch(/different tenant/);
  });

  it("expires idle sessions and forgets them", async () => {
    let t = 0;
    const c = fakeCreds();
    const s = new DeviceSessions("scope", c.factory, limits, () => t);
    s.startLogin("a", "ip");
    c.finish(0, { tid: TENANT, oid: "alice" });
    await settle();
    t = 500;
    expect(s.status("a").signedIn).toBe(true); // activity extends the session
    t = 1400;
    expect(s.status("a").signedIn).toBe(true);
    t = 2500;
    expect(s.status("a").signedIn).toBe(false);
    expect(s.has("a")).toBe(false);
  });

  it("drops the identity when the token can no longer be refreshed", async () => {
    const c = fakeCreds();
    const s = new DeviceSessions("scope", c.factory, limits);
    s.startLogin("a", "ip");
    c.finish(0, { tid: TENANT, oid: "alice" });
    await settle();
    c.failRefresh();
    expect(await s.token("a")).toBeUndefined();
    expect(s.status("a").signedIn).toBe(false);
  });

  it("caps pending flows, total sessions and logins per IP", async () => {
    const c = fakeCreds();
    const s = new DeviceSessions("scope", c.factory, limits);
    s.startLogin("a", "ip1");
    s.startLogin("b", "ip2");
    expect(() => s.startLogin("c", "ip3")).toThrow(LoginRejected); // two pending already
    c.finish(0, { tid: TENANT, oid: "a" });
    c.finish(1, { tid: TENANT, oid: "b" });
    await settle();
    s.startLogin("c", "ip3");
    expect(() => s.startLogin("d", "ip4")).toThrow(/Too many active sessions/);

    const r = new DeviceSessions("scope", fakeCreds().factory, { ...limits, maxPending: 99, maxSessions: 99 });
    r.startLogin("x1", "same");
    r.startLogin("x2", "same");
    r.startLogin("x3", "same");
    expect(() => r.startLogin("x4", "same")).toThrow(expect.objectContaining({ status: 429 }));
  });

  it("aborts a pending flow on logout", async () => {
    const c = fakeCreds();
    const s = new DeviceSessions("scope", c.factory, limits);
    s.startLogin("a", "ip");
    s.logout("a");
    await settle();
    expect(s.status("a")).toEqual({ signedIn: false });
    expect(s.size).toBe(0);
  });
});

describe("verifyArmToken", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const keys: JWTVerifyGetKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  const forged = await generateKeyPair("RS256");
  const sign = (claims: Record<string, unknown>, key = privateKey) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(key);
  const good = { tid: TENANT, oid: "alice", aud: "https://management.azure.com/", iss: `https://sts.windows.net/${TENANT}/` };

  it("accepts a valid ARM token for the pinned tenant", async () => {
    const p = await verifyArmToken(await sign(good), { tenantId: TENANT, keys });
    expect(p.oid).toBe("alice");
  });

  it("rejects forged, foreign, wrong-audience and expired tokens", async () => {
    await expect(verifyArmToken(await sign(good, forged.privateKey), { tenantId: TENANT, keys })).rejects.toThrow();
    await expect(verifyArmToken(await sign({ ...good, tid: OTHER, iss: `https://sts.windows.net/${OTHER}/` }), { tenantId: TENANT, keys })).rejects.toThrow();
    await expect(verifyArmToken(await sign({ ...good, aud: "https://graph.microsoft.com" }), { tenantId: TENANT, keys })).rejects.toThrow();
    const expired = await new SignJWT(good).setProtectedHeader({ alg: "RS256", kid: "k1" }).setExpirationTime(Math.floor(Date.now() / 1000) - 600).sign(privateKey);
    await expect(verifyArmToken(expired, { tenantId: TENANT, keys })).rejects.toThrow();
    await expect(verifyArmToken(fakeJwt(good), { tenantId: TENANT, keys })).rejects.toThrow();
  });

  it("without a pinned tenant, requires the issuer to match the token's own tenant", async () => {
    await expect(verifyArmToken(await sign(good), { keys })).resolves.toBeTruthy();
    await expect(verifyArmToken(await sign({ ...good, tid: OTHER }), { keys })).rejects.toThrow();
  });
});
