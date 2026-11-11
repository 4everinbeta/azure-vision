import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "./config";

const jwks = () =>
  createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`));
let keys: ReturnType<typeof jwks> | undefined;

/** Validates an Entra access token issued for this API (audience = client id or api://client id). */
export async function verifyToken(token: string) {
  keys ??= jwks();
  const { payload } = await jwtVerify(token, keys, {
    audience: [config.clientId, `api://${config.clientId}`],
    issuer: [
      `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
      `https://sts.windows.net/${config.tenantId}/`,
    ],
  });
  return payload;
}
