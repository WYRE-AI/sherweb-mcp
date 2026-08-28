/**
 * S2S guard ordering vs. Sherweb OAuth exchange side effect.
 *
 * The `/mcp` gateway-verification guard in `src/index.ts` (401s when
 * `CONDUIT_S2S_SECRET` is set and `verifyS2sHeader` rejects the incoming
 * `x-gateway-s2s` header) sits in front of Sherweb's own OAuth client-
 * credentials exchange. Unlike some sibling MCP servers, that exchange is
 * NOT eager: `authenticate()` in `src/utils/client.ts` is only reached
 * once a domain tool handler actually calls `distributorRequest` /
 * `serviceProviderRequest` mid `tools/call` — it is never invoked directly
 * by the HTTP request handler itself.
 *
 * `authenticate()` is module-private (not exported), so it can't be mocked
 * or spied on directly. Instead this suite instruments the network
 * boundary it drives through: the real `fetch()` POST to Sherweb's token
 * endpoint (`SHERWEB_AUTH_URL`). Global `fetch` is stubbed with a mock that
 * intercepts only Sherweb URLs (token endpoint + Distributor API base) and
 * passes every other URL — including this test's own loopback calls into
 * the in-process HTTP server — through to the real implementation, so the
 * server-under-test and the test client can coexist in one process.
 *
 * Structure:
 *  1. Missing S2S header -> 401, zero Sherweb OAuth calls.
 *  2. Invalid S2S header -> 401, zero Sherweb OAuth calls.
 *  3. Negative control — approach (a) from the ordering-guard task: a
 *     valid S2S header plus valid gateway Sherweb credential headers drive
 *     one real `tools/call` round trip through the actual HTTP server,
 *     the real per-request MCP Server/transport, and the real billing
 *     domain handler (nothing in `index.ts` or `client.ts` is mocked).
 *     The OAuth exchange fires exactly once, proving the fetch-stub
 *     apparatus used above genuinely detects the call — so the
 *     zero-calls assertions in cases 1 and 2 are not vacuously true.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { SHERWEB_AUTH_URL, SHERWEB_DISTRIBUTOR_BASE } from "./utils/types.js";
import { S2S_HEADER } from "./s2s-verify.js";

const TEST_HOST = "127.0.0.1";
const TEST_PORT = 47231;
const TEST_SECRET = "test-s2s-guard-ordering-secret-do-not-use-in-prod";

function mintS2sHeader(secret: string, unixSeconds: number): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function validS2sHeader(): string {
  return mintS2sHeader(TEST_SECRET, Math.floor(Date.now() / 1000));
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

let realFetch: typeof fetch;
let fetchMock: ReturnType<typeof vi.fn>;

async function postToMcp(
  headers: Record<string, string>,
  body: unknown
): Promise<Response> {
  return realFetch(`http://${TEST_HOST}:${TEST_PORT}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await realFetch(`http://${TEST_HOST}:${TEST_PORT}/health`);
      if (res.ok) return;
    } catch {
      // server socket not listening yet — keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test HTTP server did not become ready in time");
}

beforeAll(async () => {
  realFetch = globalThis.fetch.bind(globalThis);

  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);

    if (url === SHERWEB_AUTH_URL) {
      return new Response(
        JSON.stringify({
          access_token: "fake-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.startsWith(SHERWEB_DISTRIBUTOR_BASE)) {
      // Shape of the real GetPayableCharges response: a billing period with a
      // charge collection. The Distributor API has no per-charge endpoint, so
      // sherweb_billing_charge_details selects from this collection.
      return new Response(
        JSON.stringify({
          periodFrom: "2026-03-01",
          periodTo: "2026-03-31",
          charges: [{ chargeId: "chg_test_001", chargeName: "Test charge" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Everything else (notably this test's own loopback calls into the
    // server-under-test) goes to the real fetch implementation.
    return realFetch(input, init);
  });
  vi.stubGlobal("fetch", fetchMock);

  process.env.MCP_TRANSPORT = "http";
  process.env.AUTH_MODE = "gateway";
  process.env.MCP_HTTP_PORT = String(TEST_PORT);
  process.env.MCP_HTTP_HOST = TEST_HOST;
  process.env.CONDUIT_S2S_SECRET = TEST_SECRET;
  delete process.env.LAZY_LOADING;

  // index.ts calls main() -> startHttpTransport() unconditionally at
  // module load (it's the CLI entry point), so importing it is how the
  // server gets started for this test — same shape as the reference
  // blumira-mcp probe importing its HTTP entry module in beforeAll.
  await import("./index.js");
  await waitForServerReady();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  fetchMock.mockClear();
});

describe("S2S guard ordering vs. Sherweb OAuth exchange side effect", () => {
  it("returns 401 and never reaches the Sherweb OAuth exchange when the S2S header is missing", async () => {
    const res = await postToMcp(
      {
        "X-Sherweb-Client-ID": "test-client",
        "X-Sherweb-Client-Secret": "test-secret",
        "X-Sherweb-Subscription-Key": "test-sub-key",
      },
      { jsonrpc: "2.0", method: "tools/list", id: 1 }
    );

    expect(res.status).toBe(401);
    const authCalls = fetchMock.mock.calls.filter(([input]) => urlOf(input) === SHERWEB_AUTH_URL);
    expect(authCalls).toHaveLength(0);
  });

  it("returns 401 and never reaches the Sherweb OAuth exchange when the S2S header is invalid", async () => {
    const res = await postToMcp(
      {
        [S2S_HEADER]: mintS2sHeader("wrong-secret", Math.floor(Date.now() / 1000)),
        "X-Sherweb-Client-ID": "test-client",
        "X-Sherweb-Client-Secret": "test-secret",
        "X-Sherweb-Subscription-Key": "test-sub-key",
      },
      { jsonrpc: "2.0", method: "tools/list", id: 1 }
    );

    expect(res.status).toBe(401);
    const authCalls = fetchMock.mock.calls.filter(([input]) => urlOf(input) === SHERWEB_AUTH_URL);
    expect(authCalls).toHaveLength(0);
  });

  // Negative control (approach (a)): see file header. Proves the mock
  // apparatus above CAN detect the OAuth exchange firing, so the
  // zero-calls assertions in the two cases above are not vacuously true.
  it("DOES reach the Sherweb OAuth exchange exactly once when the S2S header is valid and a tool actually executes", async () => {
    const res = await postToMcp(
      {
        [S2S_HEADER]: validS2sHeader(),
        "X-Sherweb-Client-ID": "test-client",
        "X-Sherweb-Client-Secret": "test-secret",
        "X-Sherweb-Subscription-Key": "test-sub-key",
      },
      {
        jsonrpc: "2.0",
        method: "tools/call",
        id: 2,
        params: {
          name: "sherweb_billing_charge_details",
          arguments: { chargeId: "chg_test_001" },
        },
      }
    );

    expect(res.status).toBe(200);
    const responseBody = (await res.json()) as {
      result?: { isError?: boolean };
      error?: unknown;
    };
    expect(responseBody.error).toBeUndefined();
    expect(responseBody.result?.isError).not.toBe(true);

    const authCalls = fetchMock.mock.calls.filter(([input]) => urlOf(input) === SHERWEB_AUTH_URL);
    expect(authCalls).toHaveLength(1);
  });
});
