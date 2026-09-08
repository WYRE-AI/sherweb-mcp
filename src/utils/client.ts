/**
 * Sherweb REST Client
 *
 * Lightweight HTTP client for the Sherweb Partner API with OAuth2 client
 * credentials flow and automatic token management.
 *
 * Authentication:
 * - OAuth 2.0 Client Credentials flow
 * - Token endpoint: https://api.sherweb.com/auth/oidc/connect/token
 * - Requires client_id, client_secret, and subscription_key (Ocp-Apim-Subscription-Key header)
 * - Scopes: "distributor" and "service-provider"
 * - Tokens valid for 3600 seconds
 *
 * Base URLs:
 * - Distributor API: https://api.sherweb.com/distributor/v1
 * - Service Provider API: https://api.sherweb.com/service-provider/v1
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger.js";
import {
  SHERWEB_AUTH_URL,
  SHERWEB_DISTRIBUTOR_BASE,
  SHERWEB_SERVICE_PROVIDER_BASE,
  type SherwebCredentials,
} from "./types.js";

/**
 * OAuth2 token cache entry.
 */
interface CachedToken {
  accessToken: string;
  tokenExpiry: number;
}

/**
 * OAuth2 token cache, keyed per tenant.
 *
 * Credentials already flow per-request via AsyncLocalStorage (see
 * `credentialStore` below), but the OAuth *token* derived from those
 * credentials used to be cached in module-level `let` variables shared by
 * every request. Because Sherweb tokens are valid for ~59 minutes, that
 * meant any tenant whose request landed within another tenant's token
 * lifetime would deterministically receive the prior tenant's bearer token
 * — not a rare race, a guaranteed cross-tenant credential reuse under
 * normal multi-tenant traffic. The cache below is keyed by tenant identity
 * (clientId + subscriptionKey, the same fields that already distinguish
 * tenants when resolving raw credentials) so each tenant only ever reads
 * back its own token, while still allowing legitimate reuse of a
 * still-valid token across concurrent requests for the *same* tenant.
 */
const tokenCache = new Map<string, CachedToken>();

/**
 * Per-request credential store for gateway mode.
 * Ensures concurrent requests cannot leak credentials across tenants.
 */
const credentialStore = new AsyncLocalStorage<SherwebCredentials>();

/**
 * Derive the tenant cache key from a credential set.
 */
function tenantKey(creds: SherwebCredentials): string {
  return `${creds.clientId}::${creds.subscriptionKey}`;
}

/**
 * Run a callback with per-request credential overrides.
 * Used by the HTTP transport in gateway mode.
 */
export function runWithCredentials<T>(creds: SherwebCredentials, fn: () => T): T {
  return credentialStore.run(creds, fn);
}

/**
 * Get credentials — checks per-request store first, then falls back to env vars.
 */
export function getCredentials(): SherwebCredentials | null {
  // Per-request override (gateway mode)
  const override = credentialStore.getStore();
  if (override) {
    return override;
  }

  // Fallback to environment variables (stdio / env mode)
  const clientId = process.env.SHERWEB_CLIENT_ID;
  const clientSecret = process.env.SHERWEB_CLIENT_SECRET;
  const subscriptionKey = process.env.SHERWEB_SUBSCRIPTION_KEY;

  if (!clientId || !clientSecret || !subscriptionKey) {
    logger.warn("Missing credentials", {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      hasSubscriptionKey: !!subscriptionKey,
    });
    return null;
  }

  return { clientId, clientSecret, subscriptionKey };
}

/**
 * Authenticate with Sherweb OAuth2 endpoint.
 * Caches the token until expiry.
 */
async function authenticate(creds: SherwebCredentials): Promise<string> {
  const key = tenantKey(creds);

  // Return cached token if still valid — scoped to this tenant only.
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.tokenExpiry) {
    return cached.accessToken;
  }

  logger.debug("Authenticating with Sherweb OAuth2 endpoint");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: "distributor service-provider",
  });

  const response = await fetch(SHERWEB_AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Ocp-Apim-Subscription-Key": creds.subscriptionKey,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `Sherweb authentication failed (${response.status}): ${responseBody}`
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  // Expire 60 seconds early to avoid edge cases
  tokenCache.set(key, {
    accessToken: data.access_token,
    tokenExpiry: Date.now() + (data.expires_in - 60) * 1000,
  });

  logger.info("Sherweb authentication successful", {
    expiresIn: data.expires_in,
  });

  return data.access_token;
}

/**
 * Make an authenticated request to the Sherweb Distributor API.
 */
export async function distributorRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
  } = {}
): Promise<T> {
  const creds = getCredentials();
  if (!creds) {
    throw new Error(
      "No Sherweb API credentials configured. Please set SHERWEB_CLIENT_ID, SHERWEB_CLIENT_SECRET, and SHERWEB_SUBSCRIPTION_KEY environment variables."
    );
  }

  const token = await authenticate(creds);
  const url = new URL(`${SHERWEB_DISTRIBUTOR_BASE}${path}`);

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const method = options.method || "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Ocp-Apim-Subscription-Key": creds.subscriptionKey,
  };

  const fetchOptions: RequestInit = { method, headers };

  if (options.body !== undefined && method !== "GET") {
    fetchOptions.body = JSON.stringify(options.body);
  }

  logger.debug("Sherweb Distributor API request", { method, url: url.toString() });

  const response = await fetch(url.toString(), fetchOptions);

  // Safe: read text once, then try JSON parse
  const rawText = await response.text();
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(rawText);
  } catch {
    responseBody = rawText;
  }

  if (!response.ok) {
    handleApiError(response.status, responseBody, method, url.toString(), creds);
  }

  return responseBody as T;
}

/**
 * Make an authenticated request to the Sherweb Service Provider API.
 */
export async function serviceProviderRequest<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string | number | boolean | undefined>;
  } = {}
): Promise<T> {
  const creds = getCredentials();
  if (!creds) {
    throw new Error(
      "No Sherweb API credentials configured. Please set SHERWEB_CLIENT_ID, SHERWEB_CLIENT_SECRET, and SHERWEB_SUBSCRIPTION_KEY environment variables."
    );
  }

  const token = await authenticate(creds);
  const url = new URL(`${SHERWEB_SERVICE_PROVIDER_BASE}${path}`);

  if (options.params) {
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const method = options.method || "GET";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Ocp-Apim-Subscription-Key": creds.subscriptionKey,
  };

  const fetchOptions: RequestInit = { method, headers };

  if (options.body !== undefined && method !== "GET") {
    fetchOptions.body = JSON.stringify(options.body);
  }

  logger.debug("Sherweb Service Provider API request", { method, url: url.toString() });

  const response = await fetch(url.toString(), fetchOptions);

  // Safe: read text once, then try JSON parse
  const rawText = await response.text();
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(rawText);
  } catch {
    responseBody = rawText;
  }

  if (!response.ok) {
    handleApiError(response.status, responseBody, method, url.toString(), creds);
  }

  return responseBody as T;
}

/**
 * Handle API error responses with clear error messages.
 *
 * Every thrown message includes the request line (method + URL) that
 * produced it. A 2026-09-08 incident (Epion: customers_list 500,
 * catalog_list_products 404, billing_payable_charges 404) turned out to be
 * a stale deployment still serving pre-#67 code — the exact symptom a
 * dead/wrong-shaped path produces — but the generic `HTTP 404` /
 * `HTTP 500` messages this function used to throw gave no way to tell that
 * from a genuine, still-open bug without reading server logs. Surfacing the
 * request line in the error itself makes that distinction immediate: a
 * caller (or on-call engineer) can see whether the failing path even
 * matches what the current source calls.
 */
function handleApiError(
  status: number,
  responseBody: unknown,
  method: string,
  url: string,
  creds: SherwebCredentials
): never {
  const message =
    typeof responseBody === "object" &&
    responseBody !== null &&
    "message" in responseBody
      ? String((responseBody as Record<string, unknown>).message)
      : `HTTP ${status}`;
  const request = `${method} ${url}`;

  logger.error("Sherweb API error", { status, url, method, message });

  if (status === 401) {
    // Evict only this tenant's cached token on auth failure — never touch
    // other tenants' entries in the shared tokenCache.
    tokenCache.delete(tenantKey(creds));
    throw new Error(
      `Authentication failed: ${message}. Check your SHERWEB_CLIENT_ID, SHERWEB_CLIENT_SECRET, and SHERWEB_SUBSCRIPTION_KEY. (${request})`
    );
  }
  if (status === 403) {
    throw new Error(
      `Forbidden: ${message}. Insufficient permissions or incorrect scope. (${request})`
    );
  }
  if (status === 404) {
    throw new Error(`Not found: ${message} (${request})`);
  }
  if (status === 429) {
    throw new Error(
      `Rate limit exceeded: ${message}. Please wait and retry. (${request})`
    );
  }
  throw new Error(`Sherweb API error (${status}): ${message} (${request})`);
}
