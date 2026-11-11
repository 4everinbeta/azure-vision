import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

const ARM_AUDIENCES = [
  "https://management.azure.com",
  "https://management.azure.com/",
  "https://management.core.windows.net",
  "https://management.core.windows.net/",
];

const remote = new Map<string, JWTVerifyGetKey>();
const entraKeys = (tenant: string) => {
  let k = remote.get(tenant);
  if (!k) remote.set(tenant, (k = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`))));
  return k;
};

/**
 * Verifies an Azure Resource Manager access token forwarded between services: Entra signature, lifetime, ARM audience
 * and issuer. With `tenantId` set only that tenant is accepted; otherwise the issuer must match the token's own tenant.
 */
export async function verifyArmToken(token: string, opts: { tenantId?: string; keys?: JWTVerifyGetKey } = {}): Promise<JWTPayload> {
  const tid = (opts.tenantId || String(decodeJwt(token).tid ?? "")).toLowerCase();
  if (!/^[0-9a-f-]{36}$/i.test(tid)) throw new Error("Token has no valid tenant");
  const { payload } = await jwtVerify(token, opts.keys ?? entraKeys(opts.tenantId || "common"), {
    audience: ARM_AUDIENCES,
    issuer: [`https://sts.windows.net/${tid}/`, `https://login.microsoftonline.com/${tid}/v2.0`],
    clockTolerance: 60,
  });
  if (!payload.oid) throw new Error("Token has no object id");
  return payload;
}
