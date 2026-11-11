export const config = {
  port: Number(process.env.PORT ?? 3001),
  // "local": device-code sign-in as you, no app registration (default)
  // "arg": multi-user, MSAL in the SPA + On-Behalf-Of (needs an app registration)
  // "managed": hosted in Azure; reads Resource Graph with the app's managed identity (users sign in via Easy Auth)
  // "mock": fixture data, no Azure access
  source: (process.env.SOURCE ?? "local") as "local" | "mock" | "arg" | "managed",
  // "sqlite" (file) or "table" (Azure Table Storage, via managed identity / DefaultAzureCredential)
  store: (process.env.STORE ?? "sqlite") as "sqlite" | "table",
  tableEndpoint: process.env.STORAGE_TABLE_ENDPOINT ?? "",
  tableName: process.env.STORAGE_TABLE_NAME ?? "inventory",
  managedIdentityClientId: process.env.MANAGED_IDENTITY_CLIENT_ID || undefined,
  // Container Apps Easy Auth injects x-ms-client-principal-* headers; refuse requests without them.
  requireEasyAuth: process.env.REQUIRE_EASY_AUTH === "1",
  tenantId: process.env.AZURE_TENANT_ID ?? "",
  clientId: process.env.AZURE_CLIENT_ID ?? "",
  clientSecret: process.env.AZURE_CLIENT_SECRET ?? "",
  cacheTtlMs: Number(process.env.CACHE_TTL_MS ?? 24 * 60 * 60 * 1000), // 1 day
  costCacheTtlMs: Number(process.env.COST_CACHE_TTL_MS ?? 24 * 60 * 60 * 1000), // per-subscription; Cost Management throttles, so a refresh must be asked for
  costSpacingMs: Number(process.env.COST_SPACING_MS ?? 1500), // pause between subscription queries
  dbPath: process.env.DB_PATH ?? "data/azure-vision.db",
  host: process.env.HOST ?? "127.0.0.1",
  webDist: process.env.WEB_DIST ?? "",
  // Which API(s) this process serves: "all" (default, dev), or one of "inventory" | "cost" | "layout".
  service: (process.env.SERVICE ?? "all") as "all" | "inventory" | "cost" | "layout",
  // Cost service: base URL of the inventory service (unset = same process).
  inventoryUrl: process.env.INVENTORY_URL ?? "",
  // Optional Elasticsearch for indexing/search (unset = disabled).
  elasticUrl: (process.env.ELASTICSEARCH_URL ?? "").replace(/\/$/, ""),
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  // Device-code sessions (local mode): idle expiry and abuse limits.
  sessionIdleMs: Number(process.env.SESSION_IDLE_MS ?? 8 * 60 * 60 * 1000),
  maxSessions: Number(process.env.MAX_SESSIONS ?? 200),
  maxPendingLogins: Number(process.env.MAX_PENDING_LOGINS ?? 20),
  loginsPerIp: Number(process.env.LOGINS_PER_IP ?? 10), // per 10 minutes
  // Header carrying the browser's IP, set by the web gateway (unset = socket address). Used for sign-in rate limits.
  clientIpHeader: (process.env.CLIENT_IP_HEADER ?? "").toLowerCase(),
};
