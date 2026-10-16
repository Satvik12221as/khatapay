import { randomUUID } from "node:crypto";
import type { Line } from "../keypad/keypad";
import { orderBreakdown } from "../payments/tape";

export class PayPalError extends Error {
  constructor(msg: string, public status = 0, public debugId?: string, public body?: unknown) {
    super(msg);
    this.name = "PayPalError";
  }
}

export interface CreateOrderInput {
  paymentId: string;
  merchantName: string;
  currency: string;
  totalCents: number;
  lines: readonly Line[];
  tapeHash: string;
  requestId: string;
  returnUrl: string;
  cancelUrl: string;
}
export interface Order { id: string; status: string; approvalUrl: string }
export interface Capture { orderId: string; captureId: string; status: string }

export interface PayPal {
  mode: "mock" | "sandbox";
  createOrder(a: CreateOrderInput): Promise<Order>;
  captureOrder(orderId: string, requestId: string): Promise<Capture>;
}

const money = (cents: number) => (cents / 100).toFixed(2);
const joinUrl = (base: string, extra: string) => base + (base.includes("?") ? "&" : "?") + extra;

/** Fake PayPal for offline development and tests. Idempotent, like the real API. */
export class MockPayPal implements PayPal {
  mode = "mock" as const;
  calls: { op: string; args: unknown }[] = [];
  private seen = new Map<string, unknown>();
  private once<T>(key: string, make: () => T): T {
    if (!this.seen.has(key)) this.seen.set(key, make());
    return this.seen.get(key) as T;
  }
  async createOrder(a: CreateOrderInput): Promise<Order> {
    this.calls.push({ op: "createOrder", args: a });
    return this.once(a.requestId, () => {
      const id = "MOCK-ORD-" + randomUUID().slice(0, 8).toUpperCase();
      return { id, status: "PAYER_ACTION_REQUIRED", approvalUrl: joinUrl(a.returnUrl, `token=${id}&PayerID=MOCKPAYER`) };
    });
  }
  async captureOrder(orderId: string, requestId: string): Promise<Capture> {
    this.calls.push({ op: "captureOrder", args: { orderId } });
    return this.once(requestId, () => ({ orderId, captureId: "MOCK-CAP-" + randomUUID().slice(0, 8).toUpperCase(), status: "COMPLETED" }));
  }
}

/** Real PayPal sandbox (REST v2 Orders). */
export class SandboxPayPal implements PayPal {
  mode = "sandbox" as const;
  private base = "https://api-m.sandbox.paypal.com";
  private token?: { value: string; expiresAt: number };

  constructor(private clientId: string, private secret: string) {
    if (!clientId || !secret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_SECRET are required when PAYPAL_MODE=sandbox");
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.clientId}:${this.secret}`).toString("base64");
    const r = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new PayPalError("PayPal login failed: check CLIENT_ID and SECRET", r.status, undefined, j);
    this.token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return this.token.value;
  }

  private async post(path: string, body: unknown, requestId: string): Promise<any> {
    const r = await fetch(this.base + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", "PayPal-Request-Id": requestId },
      body: JSON.stringify(body),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new PayPalError(j.message ?? `PayPal call failed: ${path}`, r.status, j.debug_id ?? r.headers.get("paypal-debug-id") ?? undefined, j);
    return j;
  }

  async createOrder(a: CreateOrderInput): Promise<Order> {
    const { items, itemTotalCents, discountCents } = orderBreakdown(a.lines);
    const cur = a.currency;
    const amount: any = { currency_code: cur, value: money(a.totalCents), breakdown: { item_total: { currency_code: cur, value: money(itemTotalCents) } } };
    if (discountCents > 0) amount.breakdown.discount = { currency_code: cur, value: money(discountCents) };

    const j = await this.post("/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: a.paymentId,
        custom_id: a.tapeHash,                                   // the signed tape travels with the order
        description: `KhataPay bill at ${a.merchantName}`.slice(0, 127),
        amount,
        items: items.map((l, i) => ({
          name: `${i + 1}. ${l.expr}`.slice(0, 127),
          quantity: "1",
          unit_amount: { currency_code: cur, value: money(l.cents) },
          category: "PHYSICAL_GOODS",
        })),
      }],
      payment_source: { paypal: { experience_context: { return_url: a.returnUrl, cancel_url: a.cancelUrl, user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } } },
    }, a.requestId);

    const link = (j.links ?? []).find((l: any) => l.rel === "payer-action" || l.rel === "approve");
    if (!link?.href) throw new PayPalError("PayPal did not return an approval link", 502, j.debug_id, j);
    return { id: j.id, status: j.status, approvalUrl: link.href };
  }

  async captureOrder(orderId: string, requestId: string): Promise<Capture> {
    const j = await this.post(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, requestId);
    const captureId = j.purchase_units?.[0]?.payments?.captures?.[0]?.id ?? "";
    return { orderId, captureId, status: j.status };
  }
}

export function makePayPal(env: Record<string, string | undefined> = process.env): PayPal {
  if (env.PAYPAL_MODE === "sandbox") return new SandboxPayPal(env.PAYPAL_CLIENT_ID ?? "", env.PAYPAL_SECRET ?? "");
  return new MockPayPal();
}