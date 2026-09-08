/**
 * Regression tests for the cross-tenant OAuth token cache leak.
 *
 * `authenticate()` used to cache `accessToken`/`tokenExpiry` in module-level
 * `let` variables shared by every request. Sherweb tokens are valid for
 * ~59 minutes, so this was not a rare race — it was a deterministic
 * cross-tenant credential reuse under normal multi-tenant traffic: any
 * tenant whose request landed within the token's lifetime would receive
 * whichever tenant's token happened to be sitting in the shared cache.
 *
 * Two scenarios are covered, matching the standard used on the sibling
 * liongard-mcp#58 / ninjaone-mcp#71 fixes:
 *  1. A sequential test — no interleaving needed — that reproduces the bug's
 *     actual real-world trigger condition: tenant B authenticates within
 *     tenant A's still-valid token window, then tenant A makes another call.
 *  2. A forced-interleave test using manually-resolved deferred promises to
 *     make two tenants' OAuth flows genuinely overlap, asserting on the real
 *     token *values* each tenant receives (not object identity).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  distributorRequest,
  runWithCredentials,
  serviceProviderRequest,
} from "./client.js";
import { SHERWEB_AUTH_URL, type SherwebCredentials } from "./types.js";

interface PingResult {
  authHeader: string | null;
}

function tenantCreds(id: string): SherwebCredentials {
  return {
    clientId: `client-${id}`,
    clientSecret: `secret-${id}`,
    subscriptionKey: `sub-${id}`,
  };
}

function oauthResponse(accessToken: string): Response {
  const payload = JSON.stringify({
    access_token: accessToken,
    expires_in: 3600,
    token_type: "Bearer",
  });
  return {
    ok: true,
    status: 200,
    text: async () => payload,
    json: async () => JSON.parse(payload),
  } as Response;
}

function apiResponse(authHeader: string | null): Response {
  const payload = JSON.stringify({ authHeader });
  return {
    ok: true,
    status: 200,
    text: async () => payload,
    json: async () => JSON.parse(payload),
  } as Response;
}

function clientIdFromAuthRequest(init: RequestInit | undefined): string | null {
  const body = new URLSearchParams(String(init?.body ?? ""));
  return body.get("client_id");
}

function scopeFromAuthRequest(init: RequestInit | undefined): string | null {
  const body = new URLSearchParams(String(init?.body ?? ""));
  return body.get("scope");
}

function authHeaderFromApiRequest(init: RequestInit | undefined): string | null {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  return headers.Authorization ?? null;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("Sherweb OAuth token cache — cross-tenant isolation", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not let a later tenant's authentication contaminate an earlier tenant's still-valid token (sequential, no interleave)", async () => {
    // This is the bug's actual real-world trigger: no race required, just
    // two tenants' requests landing within the same ~59min token window.
    const tenantA = tenantCreds("A-seq");
    const tenantB = tenantCreds("B-seq");

    fetchMock.mockImplementation(
      async (url: string, init?: RequestInit): Promise<Response> => {
        if (url === SHERWEB_AUTH_URL) {
          const clientId = clientIdFromAuthRequest(init);
          if (clientId === tenantA.clientId) return oauthResponse("token-A-seq");
          if (clientId === tenantB.clientId) return oauthResponse("token-B-seq");
          throw new Error(`unexpected client_id in auth request: ${clientId}`);
        }
        return apiResponse(authHeaderFromApiRequest(init));
      }
    );

    // 1. Tenant A authenticates and makes a call.
    const resultA1 = await runWithCredentials(tenantA, () =>
      distributorRequest<PingResult>("/ping")
    );
    expect(resultA1).toEqual({ authHeader: "Bearer token-A-seq" });

    // 2. Tenant B authenticates within tenant A's still-valid token window.
    const resultB1 = await runWithCredentials(tenantB, () =>
      distributorRequest<PingResult>("/ping")
    );
    expect(resultB1).toEqual({ authHeader: "Bearer token-B-seq" });

    // 3. Tenant A makes another call. It must still use its OWN token —
    // under the old module-level cache this would deterministically read
    // back whatever the most recent authenticate() call had cached,
    // regardless of which tenant it belonged to.
    const resultA2 = await runWithCredentials(tenantA, () =>
      distributorRequest<PingResult>("/ping")
    );
    expect(resultA2).toEqual({ authHeader: "Bearer token-A-seq" });

    // Exactly one OAuth round trip per tenant: each tenant's second-or-later
    // call reused its own still-valid cached token instead of re-authenticating
    // (proving the cache is a real per-tenant cache, not per-request-only).
    const authCalls = fetchMock.mock.calls.filter(([url]) => url === SHERWEB_AUTH_URL);
    expect(authCalls).toHaveLength(2);
  });

  it("keeps each tenant's token isolated under a forced concurrent interleave", async () => {
    const tenantA = tenantCreds("A-interleave");
    const tenantB = tenantCreds("B-interleave");

    // Deterministic interleave: each tenant's OAuth fetch blocks on its own
    // deferred promise, so the test controls the exact resolution order
    // rather than hoping a setTimeout stagger reproduces the overlap.
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    fetchMock.mockImplementation(
      async (url: string, init?: RequestInit): Promise<Response> => {
        if (url === SHERWEB_AUTH_URL) {
          const clientId = clientIdFromAuthRequest(init);
          if (clientId === tenantA.clientId) {
            await gateA.promise;
            return oauthResponse("token-A-interleave");
          }
          if (clientId === tenantB.clientId) {
            await gateB.promise;
            return oauthResponse("token-B-interleave");
          }
          throw new Error(`unexpected client_id in auth request: ${clientId}`);
        }
        return apiResponse(authHeaderFromApiRequest(init));
      }
    );

    // Kick off both tenants' full request flows concurrently. Neither's
    // OAuth call can complete until its gate is released below, so both
    // are genuinely in flight together — a real overlap, not a stagger.
    const callA = runWithCredentials(tenantA, () =>
      distributorRequest<PingResult>("/ping")
    );
    const callB = runWithCredentials(tenantB, () =>
      distributorRequest<PingResult>("/ping")
    );

    // Resolve out of call order: tenant B's OAuth exchange completes first
    // even though tenant A's request chain started first.
    gateB.resolve();
    await Promise.resolve();
    await Promise.resolve();
    gateA.resolve();

    const [resultA, resultB] = await Promise.all([callA, callB]);

    // Assert on the real token VALUES each tenant received — not object
    // identity, which would pass even if both requests raced onto a single
    // shared value by coincidence.
    expect(resultA).toEqual({ authHeader: "Bearer token-A-interleave" });
    expect(resultB).toEqual({ authHeader: "Bearer token-B-interleave" });
  });
});

/**
 * Regression coverage for the second half of the 2026-09-08 Epion incident:
 * `sherweb_customers_list` kept returning a genuine 500 from Sherweb even
 * after the endpoint-path bug (above/PR #67) was fixed and the request
 * matched the documented `GetCustomers` contract exactly.
 *
 * `authenticate()` requested a single OAuth token with the combined scope
 * `"distributor service-provider"` for every request, regardless of which
 * API it was about to call. Sherweb's own Authorization API OpenAPI spec
 * ("you need to pass a scope depending of which API you are gonna call
 * afterwards") and its official sample code + Postman collection
 * (github.com/sherweb/Public-Apis) both request one bare scope value
 * matching the destination API — e.g. `"distributor"` for the Distributor
 * API — never a combined string. This pins the corrected behavior: each
 * request function now asks for only the scope of the API it is calling.
 */
describe("Sherweb OAuth token requests scope per API, not combined", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the bare 'distributor' scope for Distributor API calls", async () => {
    const creds = tenantCreds("scope-distributor");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === SHERWEB_AUTH_URL) return oauthResponse("token-distributor");
      return apiResponse(authHeaderFromApiRequest(init));
    });

    await runWithCredentials(creds, () => distributorRequest<PingResult>("/ping"));

    const authCall = fetchMock.mock.calls.find(([url]) => url === SHERWEB_AUTH_URL);
    expect(authCall).toBeDefined();
    expect(scopeFromAuthRequest(authCall?.[1])).toBe("distributor");
  });

  it("requests the bare 'service-provider' scope for Service Provider API calls — never the old combined value", async () => {
    const creds = tenantCreds("scope-service-provider");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === SHERWEB_AUTH_URL) return oauthResponse("token-sp");
      return apiResponse(authHeaderFromApiRequest(init));
    });

    await runWithCredentials(creds, () => serviceProviderRequest<PingResult>("/ping"));

    const authCall = fetchMock.mock.calls.find(([url]) => url === SHERWEB_AUTH_URL);
    expect(authCall).toBeDefined();
    expect(scopeFromAuthRequest(authCall?.[1])).toBe("service-provider");
  });

  it("caches a separate token per scope for the same tenant — calling both APIs authenticates twice, not once", async () => {
    const creds = tenantCreds("scope-both-apis");
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === SHERWEB_AUTH_URL) {
        const scope = scopeFromAuthRequest(init);
        return oauthResponse(`token-for-${scope}`);
      }
      return apiResponse(authHeaderFromApiRequest(init));
    });

    const distResult = await runWithCredentials(creds, () =>
      distributorRequest<PingResult>("/ping")
    );
    const spResult = await runWithCredentials(creds, () =>
      serviceProviderRequest<PingResult>("/ping")
    );

    // Each API call got a token scoped to that specific API — a token
    // minted for one is never silently reused for the other.
    expect(distResult).toEqual({ authHeader: "Bearer token-for-distributor" });
    expect(spResult).toEqual({ authHeader: "Bearer token-for-service-provider" });

    const authCalls = fetchMock.mock.calls.filter(([url]) => url === SHERWEB_AUTH_URL);
    expect(authCalls).toHaveLength(2);
  });
});

/**
 * Regression coverage for the 2026-09-08 Epion incident: customers_list
 * (500), catalog_list_products (404) and billing_payable_charges (404) all
 * turned out to be a stale container still serving pre-#67 code — the
 * request-line evidence needed to tell that from a still-open bug lived
 * only in `logger.error`, not in the error message a caller (or an
 * on-call engineer reading a bug report) actually sees. `handleApiError`
 * now includes the method + URL that failed in every thrown message.
 */
describe("Sherweb API error messages include the failing request", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const creds: SherwebCredentials = {
    clientId: "client",
    clientSecret: "secret",
    subscriptionKey: "sub-key",
  };

  function oauthResponse(): Response {
    const payload = JSON.stringify({
      access_token: "token",
      expires_in: 3600,
      token_type: "Bearer",
    });
    return {
      ok: true,
      status: 200,
      text: async () => payload,
      json: async () => JSON.parse(payload),
    } as Response;
  }

  /** Sherweb's actual undocumented error responses carry no `message` field. */
  function errorResponse(status: number, body: unknown = ""): Response {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    return {
      ok: false,
      status,
      text: async () => payload,
      json: async () => JSON.parse(payload),
    } as Response;
  }

  function stubApiResponse(response: Response) {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === SHERWEB_AUTH_URL) return oauthResponse();
      return response;
    });
  }

  it("a bare 404 (matching Sherweb's undocumented error shape) names the method and full URL", async () => {
    stubApiResponse(errorResponse(404));

    await expect(
      runWithCredentials(creds, () =>
        serviceProviderRequest("/customer-catalogs/bad-id")
      )
    ).rejects.toThrow(
      "Not found: HTTP 404 (GET https://api.sherweb.com/service-provider/v1/customer-catalogs/bad-id)"
    );
  });

  it("a bare 500 names the method and full URL, including any query params that reached Sherweb", async () => {
    stubApiResponse(errorResponse(500));

    await expect(
      runWithCredentials(creds, () =>
        // Reproduces the pre-#67 shape: unsupported params sent to an
        // endpoint that documents none of them.
        serviceProviderRequest("/customers", {
          params: { page: 1, pageSize: 50 },
        })
      )
    ).rejects.toThrow(
      "Sherweb API error (500): HTTP 500 (GET https://api.sherweb.com/service-provider/v1/customers?page=1&pageSize=50)"
    );
  });

  it("a 404 with a documented `message` field still includes the request line alongside it", async () => {
    stubApiResponse(errorResponse(404, { message: "Resource not found" }));

    await expect(
      runWithCredentials(creds, () =>
        distributorRequest("/billing/payable-charges/does-not-exist")
      )
    ).rejects.toThrow(
      "Not found: Resource not found (GET https://api.sherweb.com/distributor/v1/billing/payable-charges/does-not-exist)"
    );
  });

  it("401/403/429 messages keep their guidance text and append the request line", async () => {
    stubApiResponse(errorResponse(403));
    await expect(
      runWithCredentials(creds, () => distributorRequest("/billing/payable-charges"))
    ).rejects.toThrow(
      "Forbidden: HTTP 403. Insufficient permissions or incorrect scope. (GET https://api.sherweb.com/distributor/v1/billing/payable-charges)"
    );

    stubApiResponse(errorResponse(429));
    await expect(
      runWithCredentials(creds, () => distributorRequest("/billing/payable-charges"))
    ).rejects.toThrow(
      "Rate limit exceeded: HTTP 429. Please wait and retry. (GET https://api.sherweb.com/distributor/v1/billing/payable-charges)"
    );
  });
});
