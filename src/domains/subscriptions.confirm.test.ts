/**
 * sherweb_subscriptions_change_quantity changes billing, so it must fail
 * closed: the amendment is only POSTed on an explicit human "yes".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const elicitConfirmation = vi.fn();
const serviceProviderRequest = vi.fn();

vi.mock("../utils/elicitation.js", () => ({ elicitConfirmation }));
vi.mock("../utils/client.js", () => ({ serviceProviderRequest }));

const { subscriptionsHandler } = await import("./subscriptions.js");

const args = { customerId: "c-1", subscriptionId: "s-1", quantity: 5 };

function parse(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("sherweb_subscriptions_change_quantity confirmation", () => {
  beforeEach(() => {
    elicitConfirmation.mockReset();
    serviceProviderRequest.mockReset();
    serviceProviderRequest.mockResolvedValue({
      subscriptionsAmendmentId: "a-1",
      trackingId: { requestTrackingId: "t-1" },
    });
  });

  it.each([
    ["client without elicitation support", null],
    ["declined or dismissed prompt", null],
    ["explicit no", false],
  ])("does not submit the amendment on %s", async (_label, answer) => {
    elicitConfirmation.mockResolvedValue(answer);

    const result = await subscriptionsHandler.handleCall(
      "sherweb_subscriptions_change_quantity",
      args
    );

    expect(serviceProviderRequest).not.toHaveBeenCalled();
    expect(parse(result).cancelled).toBe(true);
  });

  it("submits the amendment on an explicit yes", async () => {
    elicitConfirmation.mockResolvedValue(true);

    const result = await subscriptionsHandler.handleCall(
      "sherweb_subscriptions_change_quantity",
      args
    );

    expect(serviceProviderRequest).toHaveBeenCalledTimes(1);
    expect(parse(result).subscriptionsAmendmentId).toBe("a-1");
  });

});

describe("sherweb_subscriptions_amendment_status trackingId validation", () => {
  beforeEach(() => {
    serviceProviderRequest.mockReset();
    serviceProviderRequest.mockResolvedValue({});
  });

  it.each([".", "..", "../customers", "abc?x=1", "a/b", "a b", "%2e%2e"])(
    "rejects %j without making a request",
    async (trackingId) => {
      const result = await subscriptionsHandler.handleCall(
        "sherweb_subscriptions_amendment_status",
        { trackingId }
      );

      expect(result.isError).toBe(true);
      expect(serviceProviderRequest).not.toHaveBeenCalled();
    }
  );

  it("requests the tracker for a GUID tracking ID", async () => {
    const trackingId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

    await subscriptionsHandler.handleCall(
      "sherweb_subscriptions_amendment_status",
      { trackingId }
    );

    expect(serviceProviderRequest).toHaveBeenCalledWith(
      `/tracking/${trackingId}`
    );
  });
});
