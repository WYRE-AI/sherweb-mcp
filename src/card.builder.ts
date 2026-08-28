/**
 * Subscription-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * sherweb_subscriptions_get results get a normalized `_card` object attached
 * (see domains/subscriptions.ts) that the ui:// subscription card renders
 * from. The card is progressive enhancement: every step here is best-effort,
 * and a null return simply means the host renders no card while the JSON
 * payload is unchanged.
 */

export const SUBSCRIPTION_CARD_RESOURCE_URI = "ui://sherweb/subscription-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const SUBSCRIPTION_CARD_META = {
  "ui/resourceUri": SUBSCRIPTION_CARD_RESOURCE_URI,
  ui: { resourceUri: SUBSCRIPTION_CARD_RESOURCE_URI },
} as const;

/** Mirror of Brand in ui/subscription-card.ts — keep in sync. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The BRAND_INJECT comment marker baked into the card HTML (see ui/index.html). */
const BRAND_INJECT_RE = /<!--\s*BRAND_INJECT:[\s\S]*?-->/;

/**
 * Serve-time brand injection: replace the BRAND_INJECT marker with an inline
 * `window.__BRAND__` script so self-hosters can theme the card without
 * rebuilding the bundle. An empty brand returns the HTML unchanged (the card
 * renders its neutral defaults). `<` is escaped so brand values can never
 * break out of the script tag.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  if (!brand || Object.values(brand).every((v) => !v)) return html;
  const json = JSON.stringify(brand).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_RE, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Guarded for
 * runtimes without `process`, where this returns an empty brand and the card
 * serves its neutral defaults.
 */
export function resolveBrandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

/** Mirror of SubscriptionCard in ui/subscription-card.ts — keep in sync. */
export interface SubscriptionCard {
  id: string;
  product: string;
  customerId: string;
  customer?: string;
  sku?: string;
  status?: string;
  quantity?: number;
  billingCycle?: string;
  commitment?: string;
  commitmentEnd?: string;
  renewalDate?: string;
  scheduledQuantity?: number;
  purchaseDate?: string;
  recurringFee?: string;
  setupFee?: string;
}

/** Non-empty string, or undefined. */
function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Finite number, or undefined. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Plain-object view of a value, or undefined. */
function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Format a fee amount with its currency, e.g. "12.50 USD". Zero fees are
 *  omitted — the card only shows charges that exist. */
function fee(amount: unknown, currency: string | undefined): string | undefined {
  const n = num(amount);
  if (n === undefined || n === 0) return undefined;
  return currency ? `${n.toFixed(2)} ${currency}` : n.toFixed(2);
}

/**
 * Build the renderable card from a sherweb_subscriptions_get payload. The
 * Sherweb API returns human-readable strings directly (productName, status,
 * billingCycle), so no id→label lookups are needed. The subscription payload
 * carries no customer name, so the caller supplies one best-effort via
 * `lookupCustomer` — Sherweb has no single-customer endpoint, so that resolves
 * against the full /customers collection.
 */
export async function buildSubscriptionCard(
  subscription: Record<string, unknown>,
  customerId: string,
  lookupCustomer: () => Promise<unknown>,
): Promise<SubscriptionCard | null> {
  const id = str(subscription?.id);
  const product =
    str(subscription?.productName) ??
    str(subscription?.name) ??
    str(subscription?.sku);
  if (!id || !product) return null;

  const card: SubscriptionCard = { id, product, customerId };

  const sku = str(subscription.sku);
  const status = str(subscription.status) ?? str(subscription.statusCode);
  const billingCycle = str(subscription.billingCycle);
  const purchaseDate = str(subscription.purchaseDate);
  const quantity = num(subscription.quantity);
  if (sku) card.sku = sku;
  if (status) card.status = status;
  if (billingCycle) card.billingCycle = billingCycle;
  if (purchaseDate) card.purchaseDate = purchaseDate;
  if (quantity !== undefined) card.quantity = quantity;

  const commitment = rec(subscription.commitmentTerm);
  if (commitment) {
    const type = str(commitment.type);
    const termEnd = str(commitment.termEndDate);
    if (type) card.commitment = type;
    if (termEnd) card.commitmentEnd = termEnd;
    const renewal = rec(commitment.renewalConfiguration);
    if (renewal) {
      const renewalDate = str(renewal.renewalDate);
      const scheduledQuantity = num(renewal.scheduledQuantity);
      if (renewalDate) card.renewalDate = renewalDate;
      if (scheduledQuantity !== undefined) card.scheduledQuantity = scheduledQuantity;
    }
  }

  const fees = rec(subscription.fees);
  if (fees) {
    const currency = str(fees.currency);
    const recurring = fee(fees.recurringFee, currency);
    const setup = fee(fees.setupFee, currency);
    if (recurring) card.recurringFee = recurring;
    if (setup) card.setupFee = setup;
  }

  // Customer display name gives the card human context for the GUID the tool
  // was called with. Best-effort: a failed lookup renders the card without it.
  try {
    const customer = rec(await lookupCustomer());
    const name =
      str(customer?.displayName) ??
      str(customer?.organizationName) ??
      str(customer?.companyName) ??
      str(customer?.name);
    if (name) card.customer = name;
  } catch {
    // Best-effort: render the card without the customer name rather than
    // failing the tool.
  }

  return card;
}
