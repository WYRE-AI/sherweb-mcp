/**
 * Contract tests pinning every tool to the URL Sherweb actually publishes.
 *
 * The server previously shipped tools whose request paths were REST-shaped
 * guesses (`/customers/{id}/subscriptions/{subId}`) rather than the
 * operation-shaped routes Sherweb documents (`/billing/subscriptions`). Eight
 * of nine tools called endpoints that do not exist, so every call 404'd while
 * tools/list looked perfectly healthy.
 *
 * Each expectation below is transcribed from the vendor's own published
 * definitions:
 *  - Distributor: Sherweb.Apis.Distributor.OpenAPI.json + the Distributor
 *    Postman collection in github.com/sherweb/Public-Apis
 *  - Service Provider: the OpenAPI definitions behind
 *    developers.sherweb.com/reference/<operation>
 *
 * These assert on the outbound URL rather than on a mock's call count: a test
 * that only counted calls would still pass against a fabricated path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithCredentials } from "../utils/client.js";
import { getAvailableDomains, getDomainHandler } from "./index.js";
import { findDomainForTool, listCategories } from "../utils/categories.js";
import { SHERWEB_AUTH_URL, type SherwebCredentials } from "../utils/types.js";

const CREDS: SherwebCredentials = {
  clientId: "client",
  clientSecret: "secret",
  subscriptionKey: "sub-key",
};

const SP = "https://api.sherweb.com/service-provider/v1";
const DIST = "https://api.sherweb.com/distributor/v1";

/** Requests the handler made to the Sherweb API (OAuth exchange excluded). */
let apiCalls: Array<{ url: string; method: string; body: unknown }>;

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as Response;
}

/**
 * Stub every Sherweb response. `apiPayload` lets a test shape the body a
 * handler has to post-process (e.g. client-side filtering).
 */
function stubFetch(apiPayload: unknown = {}) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === SHERWEB_AUTH_URL) {
      return jsonResponse({
        access_token: "token",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    apiCalls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return jsonResponse(apiPayload);
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Invoke a tool through its domain handler with credentials bound. */
async function callTool(
  domain: "billing" | "customers" | "subscriptions" | "catalog",
  toolName: string,
  args: Record<string, unknown> = {},
) {
  const handler = await getDomainHandler(domain);
  return runWithCredentials(CREDS, () => handler.handleCall(toolName, args));
}

/** The single API request the tool issued. */
function soleCall() {
  expect(apiCalls).toHaveLength(1);
  return apiCalls[0];
}

beforeEach(() => {
  apiCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("billing tools call documented Distributor endpoints", () => {
  it("payable_charges hits /billing/payable-charges with only the documented `date` param", async () => {
    stubFetch({ periodFrom: "2026-03-01", periodTo: "2026-03-31", charges: [] });

    await callTool("billing", "sherweb_billing_payable_charges", {
      date: "2026-03-17",
    });

    // The Distributor API exposes exactly one operation, and `date` is its
    // only query parameter. billingCycleType/periodFrom/periodTo are response
    // fields on Charge, not inputs, and no Sherweb endpoint paginates.
    expect(soleCall().url).toBe(`${DIST}/billing/payable-charges?date=2026-03-17`);
  });

  it("payable_charges omits the date param entirely when not supplied", async () => {
    stubFetch({ charges: [] });

    await callTool("billing", "sherweb_billing_payable_charges", {});

    // Sherweb defaults `date` to today; sending an empty value would be a
    // malformed request rather than a default.
    expect(soleCall().url).toBe(`${DIST}/billing/payable-charges`);
  });

  it("charge_details resolves a charge from the payable-charges response", async () => {
    stubFetch({
      charges: [
        { chargeId: "charge-1", chargeName: "Other" },
        { chargeId: "charge-2", chargeName: "Wanted" },
      ],
    });

    const result = await callTool("billing", "sherweb_billing_charge_details", {
      chargeId: "charge-2",
    });

    // There is no per-charge endpoint, so this must read the collection and
    // filter rather than inventing /payable-charges/{chargeId}.
    expect(soleCall().url).toBe(`${DIST}/billing/payable-charges`);
    expect(result.content[0].text).toContain("Wanted");
    expect(result.content[0].text).not.toContain("Other");
  });

  it("charge_details reports a missing charge as an error", async () => {
    stubFetch({ charges: [{ chargeId: "charge-1" }] });

    const result = await callTool("billing", "sherweb_billing_charge_details", {
      chargeId: "absent",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("absent");
  });
});

describe("customer tools call documented Service Provider endpoints", () => {
  it("customers_list hits /customers with no query parameters", async () => {
    stubFetch({ items: [] });

    await callTool("customers", "sherweb_customers_list", {});

    // GetCustomers documents no query parameters at all — the previous
    // search/page/pageSize were silently ignored by the API.
    expect(soleCall().url).toBe(`${SP}/customers`);
  });

  it("customers_list filters by search term client-side", async () => {
    stubFetch({
      items: [
        { id: "1", displayName: "Contoso Ltd" },
        { id: "2", displayName: "Fabrikam Inc" },
      ],
    });

    const result = await callTool("customers", "sherweb_customers_list", {
      search: "fabrikam",
    });

    expect(soleCall().url).toBe(`${SP}/customers`);
    expect(result.content[0].text).toContain("Fabrikam");
    expect(result.content[0].text).not.toContain("Contoso");
  });

  it("customers_get resolves a customer from the customers collection", async () => {
    stubFetch({
      items: [
        { id: "cust-1", displayName: "Contoso Ltd" },
        { id: "cust-2", displayName: "Fabrikam Inc" },
      ],
    });

    const result = await callTool("customers", "sherweb_customers_get", {
      customerId: "cust-2",
    });

    // No GET /customers/{id} exists in the Service Provider API.
    expect(soleCall().url).toBe(`${SP}/customers`);
    expect(result.content[0].text).toContain("Fabrikam");
  });

  it("accounts_receivable hits /billing/receivable-charges with customerId", async () => {
    stubFetch({ charges: [] });

    await callTool("customers", "sherweb_customers_accounts_receivable", {
      customerId: "cust-1",
    });

    expect(soleCall().url).toBe(
      `${SP}/billing/receivable-charges?customerId=cust-1`,
    );
  });

  it("accounts_receivable passes an optional billing-period date", async () => {
    stubFetch({ charges: [] });

    await callTool("customers", "sherweb_customers_accounts_receivable", {
      customerId: "cust-1",
      date: "2026-03-17",
    });

    expect(soleCall().url).toBe(
      `${SP}/billing/receivable-charges?customerId=cust-1&date=2026-03-17`,
    );
  });
});

describe("subscription tools call documented Service Provider endpoints", () => {
  it("subscriptions_list hits /billing/subscriptions with customerId as a query param", async () => {
    stubFetch({ items: [] });

    await callTool("subscriptions", "sherweb_subscriptions_list", {
      customerId: "cust-1",
    });

    // Sherweb keys subscriptions off a customerId query param, not a nested
    // /customers/{id}/subscriptions path.
    expect(soleCall().url).toBe(`${SP}/billing/subscriptions?customerId=cust-1`);
  });

  it("subscriptions_get reads /billing/subscriptions/details and filters by id", async () => {
    stubFetch({
      items: [
        { id: "sub-1", productName: "Other Product" },
        { id: "sub-2", productName: "Wanted Product" },
      ],
    });

    const result = await callTool("subscriptions", "sherweb_subscriptions_get", {
      customerId: "cust-1",
      subscriptionId: "sub-2",
    });

    // There is no single-subscription endpoint, so the tool fetches the
    // customer's details collection and filters client-side. The other call is
    // the MCP Apps card resolving the customer's display name — it must go to
    // the customers collection, since GET /customers/{id} does not exist. The
    // two run concurrently, so compare as a set: their order is scheduling
    // detail, not contract.
    expect(new Set(apiCalls.map((c) => c.url))).toEqual(
      new Set([
        `${SP}/billing/subscriptions/details?customerId=cust-1`,
        `${SP}/customers`,
      ]),
    );
    expect(result.content[0].text).toContain("Wanted Product");
    expect(result.content[0].text).not.toContain("Other Product");
  });

  it("subscriptions_get reports a missing subscription as an error", async () => {
    stubFetch({ items: [{ id: "sub-1" }] });

    const result = await callTool("subscriptions", "sherweb_subscriptions_get", {
      customerId: "cust-1",
      subscriptionId: "absent",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("absent");
  });

  it("change_quantity POSTs an amendment and returns the async receipt", async () => {
    stubFetch({
      subscriptionsAmendmentId: "amend-1",
      trackingId: { requestTrackingId: "track-1" },
    });

    const result = await callTool(
      "subscriptions",
      "sherweb_subscriptions_change_quantity",
      { customerId: "cust-1", subscriptionId: "sub-1", quantity: 12 },
    );

    const call = soleCall();
    expect(call.url).toBe(
      `${SP}/billing/subscriptions/amendments?customerId=cust-1`,
    );
    expect(call.method).toBe("POST");
    // The API takes a batch of amendments keyed `newQuantity`, not a bare
    // {quantity} body.
    expect(call.body).toEqual({
      subscriptionAmendmentParameters: [
        { subscriptionId: "sub-1", newQuantity: 12 },
      ],
    });
    // Amendments are asynchronous: the response is a receipt, not a result.
    expect(result.content[0].text).toContain("track-1");
    expect(result.content[0].text).toContain("amend-1");
  });

  it("amendment_status tracks a request via /tracking/{trackingId}", async () => {
    stubFetch("Processing");

    await callTool("subscriptions", "sherweb_subscriptions_amendment_status", {
      trackingId: "track-1",
    });

    // TrackRequest, not the deprecated amendments/{id}/status endpoint.
    expect(soleCall().url).toBe(`${SP}/tracking/track-1`);
  });
});

describe("lazy-loading category registry stays in step with the handlers", () => {
  // In lazy mode a tool missing from the category registry fails in one
  // direction only: sherweb_list_category_tools advertises it (it reads
  // getTools()) while sherweb_execute_tool rejects it as unknown (it resolves
  // the domain through the registry). Advertised-but-unrunnable is the same
  // failure shape as calling an endpoint that does not exist, so pin it.
  it("resolves a domain for every tool the handlers expose", async () => {
    for (const domain of getAvailableDomains()) {
      const handler = await getDomainHandler(domain);
      for (const tool of handler.getTools()) {
        expect(await findDomainForTool(tool.name)).toBe(domain);
      }
    }
  });

  it("resolves no domain for an unknown tool", async () => {
    expect(await findDomainForTool("sherweb_not_a_real_tool")).toBeNull();
  });

  it("reports a tool count per category matching the handler", async () => {
    const categories = await listCategories();
    expect(categories.map((c) => c.name)).toEqual(getAvailableDomains());

    for (const category of categories) {
      const handler = await getDomainHandler(category.name);
      expect(category.toolCount).toBe(handler.getTools().length);
    }
  });
});

describe("catalog tools call documented Service Provider endpoints", () => {
  it("list_products hits the per-customer catalog endpoint", async () => {
    stubFetch({ customerId: "cust-1", catalogItems: [] });

    await callTool("catalog", "sherweb_catalog_list_products", {
      customerId: "cust-1",
    });

    // Sherweb has no global product catalog; catalogs are scoped per customer.
    expect(soleCall().url).toBe(`${SP}/customer-catalogs/cust-1`);
  });

  it("list_products filters catalog items by search term client-side", async () => {
    stubFetch({
      customerId: "cust-1",
      catalogItems: [
        { sku: "SKU-A", name: [{ culture: "en", value: "Exchange Online" }] },
        { sku: "SKU-B", name: [{ culture: "en", value: "Teams Phone" }] },
      ],
    });

    const result = await callTool("catalog", "sherweb_catalog_list_products", {
      customerId: "cust-1",
      search: "teams",
    });

    expect(soleCall().url).toBe(`${SP}/customer-catalogs/cust-1`);
    expect(result.content[0].text).toContain("Teams Phone");
    expect(result.content[0].text).not.toContain("Exchange Online");
  });
});
