import { describe, it, expect, vi, afterEach } from "vitest";
import { replay } from "../src/payments/replay";
import { tapeHash, orderBreakdown } from "../src/payments/tape";
import { SandboxPayPal } from "../src/paypal/client";
import type { Key } from "../src/keypad/keypad";

const keys = (s: string) => s.replace(/\*/g, "×").replace(/\//g, "÷").split("") as Key[];
const base = (s: string) => { const v = replay(keys(s)); return { merchantId: "shop1", currency: "USD", lines: v.lines, totalCents: v.totalCents! }; };

describe("replay", () => {
  it("recomputes the same total the browser would show", () => expect(replay(keys("30+40+20")).totalCents).toBe(9000));
  it("handles backspace and clear in the recorded keys", () => {
    expect(replay(["3", "0", "0", "back", "+", "4"] as Key[]).totalCents).toBe(3400);
    expect(replay(["9", "9", "clear", "5"] as Key[]).totalCents).toBe(500);
  });
});

describe("signed tape", () => {
  it("is stable for the same bill", () => expect(tapeHash(base("30+40"))).toBe(tapeHash(base("30+40"))));
  it("changes if anything changes", () => {
    const h = tapeHash(base("30+40"));
    expect(tapeHash(base("30+41"))).not.toBe(h);
    expect(tapeHash({ ...base("30+40"), merchantId: "shop2" })).not.toBe(h);
    expect(tapeHash({ ...base("30+40"), currency: "EUR" })).not.toBe(h);
    expect(tapeHash({ ...base("30+40"), totalCents: 7001 })).not.toBe(h);
  });
  it("is 64 hex chars (fits PayPal custom_id, max 255)", () => expect(tapeHash(base("5"))).toMatch(/^[0-9a-f]{64}$/));
});

describe("order breakdown", () => {
  it("itemTotal - discount equals the total", () => {
    const v = replay(keys("30+40+20-5"));
    const b = orderBreakdown(v.lines);
    expect(b.items).toHaveLength(3);
    expect(b.itemTotalCents).toBe(9000);
    expect(b.discountCents).toBe(500);
    expect(b.itemTotalCents - b.discountCents).toBe(v.totalCents);
  });
});

describe("SandboxPayPal request shape (fetch is stubbed, no network)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("sends tape as items, discount in breakdown, hash in custom_id, idempotency key", async () => {
    const calls: { url: string; init: any }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "T", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ id: "ORD1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "payer-action", href: "https://paypal.test/approve" }] }), { status: 201 });
    }));
    const pp = new SandboxPayPal("id", "secret");
    const v = replay(keys("30+40+20-5"));
    const hash = tapeHash({ merchantId: "shop1", currency: "USD", lines: v.lines, totalCents: v.totalCents! });
    const order = await pp.createOrder({ paymentId: "P1", merchantName: "Shop", currency: "USD", totalCents: v.totalCents!, lines: v.lines, tapeHash: hash, requestId: "req-1", returnUrl: "http://r", cancelUrl: "http://c" });
    expect(order).toEqual({ id: "ORD1", status: "PAYER_ACTION_REQUIRED", approvalUrl: "https://paypal.test/approve" });

    const orderCall = calls.find((c) => c.url.endsWith("/v2/checkout/orders"))!;
    expect(orderCall.init.headers["PayPal-Request-Id"]).toBe("req-1");
    const unit = JSON.parse(orderCall.init.body).purchase_units[0];
    expect(unit.amount.value).toBe("85.00");
    expect(unit.amount.breakdown.item_total.value).toBe("90.00");
    expect(unit.amount.breakdown.discount.value).toBe("5.00");
    expect(unit.items).toHaveLength(3);
    expect(unit.custom_id).toBe(hash);
  });
  it("throws a clear error when PayPal rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/token")
      ? new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 })
      : new Response("{}", { status: 500 })));
    await expect(new SandboxPayPal("bad", "bad").captureOrder("X", "r")).rejects.toThrow(/login failed/);
  });
});