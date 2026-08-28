/**
 * Tool categories for lazy-loading meta-tools mode.
 *
 * When LAZY_LOADING=true, the server exposes only four meta-tools instead of
 * the full decision-tree navigation. Clients discover available tools by
 * category, then load schemas on demand.
 *
 * Tool membership is derived from the domain handlers that define the tools,
 * never hand-listed. A hand-maintained copy drifts silently and in exactly one
 * direction: a tool missing from the list is still advertised by
 * `sherweb_list_category_tools` (which reads `getTools()`) but rejected by
 * `sherweb_execute_tool` (which resolves the domain through this module) —
 * advertised-but-unrunnable, the same failure shape as calling an endpoint
 * that does not exist.
 */

import { getAvailableDomains, getDomainHandler } from "../domains/index.js";
import type { DomainName } from "./types.js";

/**
 * Human-readable description of each domain. Single source of truth — the
 * navigation tool and the category meta-tools both read this.
 */
export const DOMAIN_DESCRIPTIONS: Record<DomainName, string> = {
  billing: "Distributor payable charges for a billing period, and charge detail",
  customers: "List and look up customers, and their receivable charges",
  subscriptions:
    "List subscriptions, get details, and submit quantity amendments",
  catalog: "Per-customer product catalog browsing",
};

/** The tool names a domain owns, read from the handler that defines them. */
async function toolNamesFor(domain: DomainName): Promise<string[]> {
  const handler = await getDomainHandler(domain);
  return handler.getTools().map((tool) => tool.name);
}

/** Every category with its description and live tool count. */
export async function listCategories(): Promise<
  Array<{ name: DomainName; description: string; toolCount: number }>
> {
  return Promise.all(
    getAvailableDomains().map(async (domain) => ({
      name: domain,
      description: DOMAIN_DESCRIPTIONS[domain],
      toolCount: (await toolNamesFor(domain)).length,
    }))
  );
}

/**
 * Reverse lookup: given a tool name, return the domain that owns it.
 */
export async function findDomainForTool(
  toolName: string
): Promise<DomainName | null> {
  for (const domain of getAvailableDomains()) {
    if ((await toolNamesFor(domain)).includes(toolName)) {
      return domain;
    }
  }
  return null;
}

/**
 * Simple keyword-to-tool router. Maps common intent phrases to suggested
 * tools so the LLM can ask "what tool should I use for X?" without loading
 * every schema.
 */
const INTENT_KEYWORDS: Record<string, string[]> = {
  // Billing
  billing: ["sherweb_billing_payable_charges", "sherweb_billing_charge_details"],
  charges: ["sherweb_billing_payable_charges", "sherweb_billing_charge_details"],
  payable: ["sherweb_billing_payable_charges"],
  invoice: ["sherweb_billing_payable_charges"],
  "billing period": ["sherweb_billing_payable_charges"],
  pricing: ["sherweb_billing_charge_details"],
  deductions: ["sherweb_billing_charge_details"],
  fees: ["sherweb_billing_charge_details"],
  taxes: ["sherweb_billing_charge_details"],
  // Customers
  customer: ["sherweb_customers_list", "sherweb_customers_get"],
  customers: ["sherweb_customers_list"],
  "accounts receivable": ["sherweb_customers_accounts_receivable"],
  receivable: ["sherweb_customers_accounts_receivable"],
  // Subscriptions
  subscription: ["sherweb_subscriptions_list", "sherweb_subscriptions_get"],
  subscriptions: ["sherweb_subscriptions_list"],
  quantity: ["sherweb_subscriptions_change_quantity"],
  license: ["sherweb_subscriptions_change_quantity"],
  seats: ["sherweb_subscriptions_change_quantity"],
  amendment: [
    "sherweb_subscriptions_change_quantity",
    "sherweb_subscriptions_amendment_status",
  ],
  tracking: ["sherweb_subscriptions_amendment_status"],
  // Catalog
  catalog: ["sherweb_catalog_list_products"],
  product: ["sherweb_catalog_list_products"],
  products: ["sherweb_catalog_list_products"],
};

/**
 * Given a free-text intent string, return the best-matching tool suggestions.
 */
export function routeIntent(intent: string): string[] {
  const lower = intent.toLowerCase();
  const matches = new Set<string>();

  for (const [keyword, tools] of Object.entries(INTENT_KEYWORDS)) {
    if (lower.includes(keyword)) {
      for (const tool of tools) {
        matches.add(tool);
      }
    }
  }

  return [...matches];
}
