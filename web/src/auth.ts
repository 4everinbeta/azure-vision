import { PublicClientApplication } from "@azure/msal-browser";

export interface ServerConfig { source: "local" | "mock" | "arg" | "managed"; user?: string; tenantId: string; clientId: string }

let msal: PublicClientApplication | undefined;
let scopes: string[] = [];

export async function initAuth(cfg: ServerConfig) {
  if (cfg.source !== "arg") return;
  msal = new PublicClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      redirectUri: window.location.origin,
    },
    cache: { cacheLocation: "sessionStorage" },
  });
  await msal.initialize();
  scopes = [`api://${cfg.clientId}/access_as_user`];
}

export async function getToken(): Promise<string | undefined> {
  if (!msal) return undefined;
  const account = msal.getAllAccounts()[0];
  if (!account) {
    const r = await msal.loginPopup({ scopes });
    msal.setActiveAccount(r.account);
    return (await msal.acquireTokenSilent({ scopes, account: r.account })).accessToken;
  }
  try {
    return (await msal.acquireTokenSilent({ scopes, account })).accessToken;
  } catch {
    return (await msal.acquireTokenPopup({ scopes })).accessToken;
  }
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
