/**
 * Catalog domain tools for Sherweb MCP Server
 *
 * Handles product catalog browsing.
 * Uses the Service Provider API (v1 Beta): https://api.sherweb.com/service-provider/v1
 *
 * Sherweb has no global product catalog — catalogs are scoped per customer,
 * because available offers and terms differ by customer. The endpoint takes no
 * query parameters, so search is applied client-side over the returned items.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  type DomainHandler,
  type CallToolResult,
  errorResult,
  jsonResult,
  matches,
  requireString,
} from "../utils/types.js";
import { serviceProviderRequest } from "../utils/client.js";
import { logger } from "../utils/logger.js";

/** Sherweb customer IDs are GUIDs; allow only ID-shaped values in the path. */
const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9-]+$/;

/** The parts of the CustomerCatalog response this handler reads. */
interface CatalogItem {
  sku?: string;
  name?: Array<{ value?: string }>;
}

interface CustomerCatalog {
  catalogItems?: CatalogItem[];
}

/**
 * Catalog domain tool definitions
 */
function getTools(): Tool[] {
  return [
    {
      name: "sherweb_catalog_list_products",
      description:
        "List the products a specific customer can be sold, with SKU, localized name and description, billing cycle and commitment term. Catalogs are per-customer in Sherweb — there is no global product list.",
      inputSchema: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description:
              "The customer whose catalog to browse (UUID). Required — offers differ per customer.",
          },
          search: {
            type: "string",
            description:
              "Optional case-insensitive filter on SKU or product name. Sherweb returns the full catalog, so this is applied locally.",
          },
        },
        required: ["customerId"],
      },
    },
  ];
}

/** Does a catalog item match the search needle, in any culture? */
function itemMatches(item: CatalogItem, needle: string): boolean {
  return (
    matches(item.sku, needle) ||
    (item.name ?? []).some((n) => matches(n.value, needle))
  );
}

/**
 * Handle catalog domain tool calls
 */
async function handleCall(
  toolName: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  switch (toolName) {
    case "sherweb_catalog_list_products": {
      const customerId = requireString(args, "customerId", toolName);
      const { search } = args as { search?: string };

      // customerId is a path segment. Without this check "../customers" or
      // "../../distributor/..." resolves to another endpoint on the same API
      // host with the same token.
      if (!CUSTOMER_ID_PATTERN.test(customerId)) {
        return errorResult(
          `${toolName}: invalid customerId '${customerId}'. Expected a Sherweb customer ID from sherweb_customers_list (letters, digits and hyphens only).`
        );
      }

      logger.info("API call: catalog.getCustomerCatalog", {
        customerId,
        search,
      });

      const response = await serviceProviderRequest<CustomerCatalog>(
        `/customer-catalogs/${encodeURIComponent(customerId)}`
      );

      const needle = (search ?? "").toLowerCase();
      const catalogItems = (response.catalogItems ?? []).filter((item) =>
        itemMatches(item, needle)
      );

      return jsonResult({ ...response, catalogItems });
    }

    default:
      return errorResult(`Unknown catalog tool: ${toolName}`);
  }
}

export const catalogHandler: DomainHandler = { getTools, handleCall };
