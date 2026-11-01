import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MERCHANTS } from "../src/merchants";
import { PaymentStore, type Payment } from "../src/payments/store";
import type { PayoutInput } from "../src/paypal/client";
import { ReferralStore } from "../src/referrals/store";
import { ReferralService } from "../src/referrals/service";
import { registerReferralRoutes } from "../src/referrals/routes";
import { DEFAULT_POLICY, type ReferralPolicy } from "../src/referrals/rules";
import { LocalRecommender, RemoteRecommender, checkRecommendation, makeRecommender, type RecommendInput, type Recommender } from "../src/agents/recommender";

class FakePayPal {
  mode = "mock" as const;
  calls: PayoutInput[] = [];
  fail = false;
  private seen = new Map<string, string>();
  async payout(a: PayoutInput) {
    if (this.fail) throw new Error("PayPal is down");
    this.calls.push(a);
    if (!this.seen.has(a.batchId)) this.seen.set(a.batchId, "PAYOUT-" + this.seen.size);
    return { batchId: this.seen.get(a.batchId)!, status: "SUCCESS" };
  }
}

let n = 0;
function setup(opts: { policy?: Partial<ReferralPolicy>; recommender?: Recommender; now?: () => number; file?: string } = {}) {
  const payments = new PaymentStore();
  const store = new ReferralStore(opts.file);
  const pp = new FakePayPal();
  const svc = new ReferralService({ payments, store, pp, recommender: opts.recommender ?? new LocalRecommender(), merchants: MERCHANTS, policy: { ...DEFAULT_POLICY, ...opts.policy }, now: opts.now });
  const app = Fastify();
  app.setErrorHandler((err: any, _q, reply) => reply.code(err.name === "ZodError" ? 400 : err.statusCode ?? 500).send({ error: "ERROR", message: err.message }));
  registerReferralRoutes(app, svc);       // BEFORE the payment routes, as the instructions say
  // stand-ins for the real payment routes: they only change the payment state
  const set = (id: string, state: Payment["state"], extra: Partial<Payment> = {}) => payments.update(id, { state, ...extra });
  app.post("/api/payments/:id/confirm", async (r) => set((r.params as any).id, "RELEASED"));
  app.post("/api/payments/:id/refund", async (r) => set((r.params as any).id, "REFUNDED"));
  app.post("/api/payments/:id/judge", async (r) => set((r.params as any).id, "RELEASED", { dispute: { reason: "not_received", note: "", openedAt: "", verdict: { votes: [], outcome: "release" } } }));
  app.get("/pay/cancel", async (r) => set((r.query as any).payment, "CANCELLED"));
  const newPayment = (merchantId: string, state: Payment["state"], amountCents = 2000): Payment => {
    const id = `pay-${++n}`;
    return payments.add({ id, merchantId, merchantName: "x", amountCents, currency: "USD", lines: [], tapeHash: "h", state, orderId: "o", createdAt: new Date().toISOString(), events: [] });
  };
  const J = (r: any) => r.json();
  const post = (url: string, payload: any = {}) => app.inject({ method: "POST", url, payload });
  /** a customer who is already a regular at shop1 with a PayPal email */
  const regular = async (name = "Asha", email = "asha@example.com", orders = 2) => {
    const c = J(await post("/api/customers", { name, paypalEmail: email }));
    for (let i = 0; i < orders; i++) store.link(newPayment("shop1", "RELEASED").id, c.id, "shop1");
    return c;
  };
  const friend = async (name = "Ravi") => J(await post("/api/customers", { name }));
  /** friend's first order: created, linked with the code, captured */
  const firstOrder = async (friendId: string, code: string | undefined, merchantId = "shop1", amount = 1800) => {
    const p = newPayment(merchantId, "CREATED", amount);
    const link = J(await post(`/api/customers/${friendId}/link`, { paymentId: p.id, ...(code ? { referralCode: code } : {}) }));
    set(p.id, "HELD");
    return { p, link };
  };
  return { app, svc, store, payments, pp, post, J, set, newPayment, regular, friend, firstOrder };
}

describe("customers and trust", () => {
  it("creates customers with a referral code and validates input", async () => {
    const t = setup();
    const c = t.J(await t.post("/api/customers", { name: "Asha Rao", paypalEmail: "asha@example.com" }));
    expect(c.referralCode).toMatch(/^ASHA-[0-9A-F]{4}$/);
    expect((await t.post("/api/customers", { paypalEmail: "not-an-email" })).statusCode).toBe(400);
    expect(t.J(await t.post("/api/customers", {})).name).toBe("Guest");
  });
  it("serves live trust scores, which move when real payments finish", async () => {
    const t = setup();
    const before = t.J(await t.app.inject({ url: "/api/trust" }));
    expect(before.map((x: any) => [x.merchantId, x.score])).toEqual([["shop1", 97], ["shop2", 62], ["shop3", 75]]);
    for (let i = 0; i < 3; i++) t.newPayment("shop3", "RELEASED");
    t.newPayment("shop3", "REFUNDED").dispute = { reason: "other", note: "", openedAt: "", verdict: { votes: [], outcome: "refund" } };
    const after = t.J(await t.app.inject({ url: "/api/trust" })).find((x: any) => x.merchantId === "shop3");
    expect(after.stats).toEqual({ completed: 3, disputesLost: 1, repeatCustomers: 0 });
    expect(after.explanation).toContain("3 orders completed, 1 disputes lost");
  });
});

describe("the referral agent (draft)", () => {
  it("a regular gets a fact-based message and the pitch is saved for the friend's landing page", async () => {
    const t = setup();
    const a = await t.regular();
    const d = t.J(await t.post(`/api/customers/${a.id}/refer`, {}));
    expect(d).toMatchObject({ merchantId: "shop1", source: "scripted", code: a.referralCode, path: `/?ref=${a.referralCode}&shop=shop1`, welcomeCents: 200, rewardCents: 300 });
    expect(d.message).toContain("trust score of 97");
    const land = t.J(await t.app.inject({ url: `/api/referrals/landing?code=${a.referralCode}&shop=shop1` }));
    expect(land).toMatchObject({ valid: true, referrerName: "Asha", merchantName: "Lakshmi Provision Store", welcomeCents: 200, minOrderCents: 1000 });
    expect(land.message).toBe(d.message);
    expect(land.referrerEmail).toBeUndefined();
  });
  it("is refused until the customer is a regular with an email", async () => {
    const t = setup();
    const noEmail = t.J(await t.post("/api/customers", { name: "Zed" }));
    expect((await t.post(`/api/customers/${noEmail.id}/refer`, {})).statusCode).toBe(422);
    const newbie = await t.regular("Neha", "neha@example.com", 1);
    const r = await t.post(`/api/customers/${newbie.id}/refer`, {});
    expect(r.statusCode).toBe(422);
    expect(t.J(r).message).toContain("Complete 2 orders");
  });
  it("the friend's note steers which shop is picked among the regular's shops", async () => {
    const t = setup({ policy: { minOrdersToRefer: 1 } });
    const a = t.J(await t.post("/api/customers", { name: "Asha", paypalEmail: "a@example.com" }));
    t.store.link(t.newPayment("shop1", "RELEASED").id, a.id, "shop1");
    t.store.link(t.newPayment("shop3", "RELEASED").id, a.id, "shop3");
    expect(t.J(await t.post(`/api/customers/${a.id}/refer`, { needs: "" })).merchantId).toBe("shop1");
    expect(t.J(await t.post(`/api/customers/${a.id}/refer`, { needs: "sweets for diwali" })).merchantId).toBe("shop3");
  });
  it("a clear need picks the matching shop even when another has a higher trust score, but never one below the minimum", async () => {
    const t = setup({ policy: { minOrdersToRefer: 1 } });
    const a = t.J(await t.post("/api/customers", { name: "Asha", paypalEmail: "a@example.com" }));
    t.store.link(t.newPayment("shop1", "RELEASED").id, a.id, "shop1");
    t.store.link(t.newPayment("shop2", "RELEASED").id, a.id, "shop2");
    expect(t.J(await t.post(`/api/customers/${a.id}/refer`, { needs: "" })).merchantId).toBe("shop1");
    expect(t.J(await t.post(`/api/customers/${a.id}/refer`, { needs: "fresh organic vegetables" })).merchantId).toBe("shop2");
    const strict = setup({ policy: { minOrdersToRefer: 1, minTrust: 70 } });
    const b = strict.J(await strict.post("/api/customers", { name: "Bo", paypalEmail: "b@example.com" }));
    strict.store.link(strict.newPayment("shop1", "RELEASED").id, b.id, "shop1");
    strict.store.link(strict.newPayment("shop2", "RELEASED").id, b.id, "shop2");
    expect(strict.J(await strict.post(`/api/customers/${b.id}/refer`, { needs: "fresh organic vegetables" })).merchantId).toBe("shop1");
  });
  it("landing pages: unknown code is 404, and a referrer who lost eligibility is invalid", async () => {
    const t = setup();
    expect((await t.app.inject({ url: "/api/referrals/landing?code=NOPE&shop=shop1" })).statusCode).toBe(404);
    const a = await t.regular("Mia", "mia@example.com", 1);
    expect(t.J(await t.app.inject({ url: `/api/referrals/landing?code=${a.referralCode}&shop=shop1` })).valid).toBe(false);
  });
});

describe("the full referral lifecycle", () => {
  it("friend's first order completes: the referrer is paid once, through PayPal Payouts", async () => {
    const t = setup();
    const a = await t.regular();
    const b = await t.friend();
    const { p, link } = await t.firstOrder(b.id, a.referralCode);
    expect(link.referral).toMatchObject({ state: "PENDING", welcomeCents: 200 });
    expect(t.pp.calls).toHaveLength(0);                                   // nothing is paid while the order is open
    await t.post(`/api/payments/${p.id}/confirm`);
    expect(t.pp.calls).toEqual([{ email: "asha@example.com", amountCents: 300, currency: "USD", note: "KhataPay referral reward", batchId: expect.stringContaining("khatapay-referral-") }]);
    const dash = t.J(await t.app.inject({ url: `/api/customers/${a.id}` }));
    expect(dash.earnedCents).toBe(300);
    expect(dash.referrals[0]).toMatchObject({ role: "referrer", state: "REWARDED", rewardCents: 300, merchantName: "Lakshmi Provision Store" });
    await t.svc.sync(p.id); await t.svc.sync(p.id);
    expect(t.pp.calls).toHaveLength(1);                                   // idempotent
  });
  it("is voided, with a reason, when the order is refunded, cancelled or won by the shop only after a dispute", async () => {
    const t = setup();
    const a = await t.regular();
    for (const [route, want] of [["refund", "not completed"], ["judge", "disputed"]] as const) {
      const b = await t.friend();
      const { p } = await t.firstOrder(b.id, a.referralCode);
      await t.post(`/api/payments/${p.id}/${route}`);
      const r = t.svc.mine(a.id).find((x) => x.state === "VOID" && x.reason?.includes(want));
      expect(r, route).toBeDefined();
    }
    const c = await t.friend();
    const first = await t.firstOrder(c.id, a.referralCode);
    t.set(first.p.id, "CREATED");
    await t.app.inject({ url: `/pay/cancel?payment=${first.p.id}` });
    expect(t.svc.mine(a.id).filter((x) => x.state === "VOID")).toHaveLength(3);
    expect(t.pp.calls).toHaveLength(0);
  });
  it("blocks fraud: self-referral, same email, returning customers, tiny orders, one referral per friend", async () => {
    const t = setup();
    const a = await t.regular();
    expect((await t.firstOrder(a.id, a.referralCode)).link.referralRejected).toContain("own referral");
    const twin = t.J(await t.post("/api/customers", { name: "Asha2", paypalEmail: "ASHA@example.com" }));
    expect((await t.firstOrder(twin.id, a.referralCode)).link.referralRejected).toContain("own referral");
    const old = await t.regular("Old", "old@example.com", 1);
    expect((await t.firstOrder(old.id, a.referralCode)).link.referralRejected).toContain("first orders");
    const tiny = await t.friend("Tiny");
    expect((await t.firstOrder(tiny.id, a.referralCode, "shop1", 900)).link.referralRejected).toContain("at least $10");
    const b = await t.friend();
    const ok = await t.firstOrder(b.id, a.referralCode, "shop1", 1500);
    expect(ok.link.referral.state).toBe("PENDING");
    expect((await t.firstOrder(b.id, a.referralCode)).link.referralRejected).toContain("first orders");        // money already taken once
    expect((await t.firstOrder((await t.friend("Q")).id, undefined)).link.referral).toBeUndefined();           // no code, no claim
    const p1 = t.newPayment("shop1", "CREATED", 1500), p2 = t.newPayment("shop1", "CREATED", 1500);
    const d = await t.friend("Dee");
    expect(t.J(await t.post(`/api/customers/${d.id}/link`, { paymentId: p1.id, referralCode: a.referralCode })).referral.state).toBe("PENDING");
    expect(t.J(await t.post(`/api/customers/${d.id}/link`, { paymentId: p2.id, referralCode: a.referralCode })).referralRejected).toContain("in progress");
    const e = await t.friend("Eve");
    expect(t.J(await t.post(`/api/customers/${e.id}/link`, { paymentId: t.newPayment("shop1", "CREATED", 1500).id, referralCode: "NOPE-0000" })).referralRejected).toContain("Unknown");
  });
  it("a friend whose first attempt was cancelled can still use the referral on the next try", async () => {
    const t = setup();
    const a = await t.regular(); const b = await t.friend();
    const first = await t.firstOrder(b.id, a.referralCode);
    t.set(first.p.id, "CREATED");
    await t.app.inject({ url: `/pay/cancel?payment=${first.p.id}` });
    const second = await t.firstOrder(b.id, a.referralCode);
    expect(second.link.referral.state).toBe("PENDING");
    await t.post(`/api/payments/${second.p.id}/confirm`);
    expect(t.pp.calls).toHaveLength(1);
  });
  it("won't recommend a shop below the trust minimum", async () => {
    const t = setup({ policy: { minTrust: 70 } });
    const a = t.J(await t.post("/api/customers", { name: "Zoya", paypalEmail: "z@example.com" }));
    for (let i = 0; i < 2; i++) t.store.link(t.newPayment("shop2", "RELEASED").id, a.id, "shop2");
    expect((await t.post(`/api/customers/${a.id}/refer`, {})).statusCode).toBe(422);
    const b = await t.friend();
    expect((await t.firstOrder(b.id, a.referralCode, "shop2")).link.referralRejected).toContain("no longer available");
  });
  it("caps rewards: 5 per 30 days, and a lifetime total", async () => {
    const t = setup({ policy: { maxRewardsPer30d: 2, lifetimeCapCents: 900 } });
    const a = await t.regular();
    for (let i = 0; i < 3; i++) { const b = await t.friend(`F${i}`); const { p } = await t.firstOrder(b.id, a.referralCode); await t.post(`/api/payments/${p.id}/confirm`); }
    const rs = t.svc.mine(a.id);
    expect(rs.filter((r) => r.state === "REWARDED")).toHaveLength(2);
    expect(rs.find((r) => r.state === "VOID")?.reason).toContain("monthly");
    const t2 = setup({ policy: { lifetimeCapCents: 600 } });
    const a2 = await t2.regular();
    for (let i = 0; i < 3; i++) { const b = await t2.friend(`G${i}`); const { p } = await t2.firstOrder(b.id, a2.referralCode); await t2.post(`/api/payments/${p.id}/confirm`); }
    expect(t2.svc.mine(a2.id).find((r) => r.state === "VOID")?.reason).toContain("lifetime");
  });
  it("expires a referral that settles too late", async () => {
    let now = Date.now();
    const t = setup({ now: () => now });
    const a = await t.regular(); const b = await t.friend();
    const { p } = await t.firstOrder(b.id, a.referralCode);
    now += 31 * 86_400_000;
    await t.post(`/api/payments/${p.id}/confirm`);
    expect(t.svc.mine(a.id)[0]).toMatchObject({ state: "VOID", reason: "The referral expired." });
  });
  it("a failed payout leaves the reward pending and the next visit pays it exactly once", async () => {
    const t = setup();
    const a = await t.regular(); const b = await t.friend();
    const { p } = await t.firstOrder(b.id, a.referralCode);
    t.pp.fail = true;
    expect((await t.post(`/api/payments/${p.id}/confirm`)).statusCode).toBe(200);   // the customer's own payment is not affected
    expect(t.svc.mine(a.id)[0].state).toBe("PENDING");
    t.pp.fail = false;
    const dash = t.J(await t.app.inject({ url: `/api/customers/${a.id}` }));        // opening the dashboard retries
    expect(dash.referrals[0].state).toBe("REWARDED");
    expect(t.pp.calls).toHaveLength(1);
  });
  it("linking is safe: unknown payments, other people's payments, repeat calls", async () => {
    const t = setup();
    const a = await t.regular(); const b = await t.friend(); const c = await t.friend("Cara");
    expect((await t.post(`/api/customers/${b.id}/link`, { paymentId: "nope" })).statusCode).toBe(404);
    expect((await t.post(`/api/customers/unknown/link`, { paymentId: "x" })).statusCode).toBe(404);
    const { p } = await t.firstOrder(b.id, a.referralCode);
    expect((await t.post(`/api/customers/${c.id}/link`, { paymentId: p.id })).statusCode).toBe(409);
    expect(t.J(await t.post(`/api/customers/${b.id}/link`, { paymentId: p.id, referralCode: a.referralCode })).referral.state).toBe("PENDING");
    expect(t.store.allReferrals()).toHaveLength(1);
  });
  it("customers, links and referrals survive a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kp-ref-")); const file = join(dir, "r.json");
    try {
      const t = setup({ file });
      const a = await t.regular(); const b = await t.friend();
      await t.firstOrder(b.id, a.referralCode);
      const again = new ReferralStore(file);
      expect(again.findByCode(a.referralCode)?.name).toBe("Asha");
      expect(again.allReferrals()).toHaveLength(1);
      expect(again.paymentsOf(a.id)).toHaveLength(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the recommender service bridge", () => {
  const input: RecommendInput = {
    referrerName: "Asha", needs: "", welcomeCents: 200, rewardCents: 300, minTrust: 60,
    candidates: [{ shopId: "shop1", name: "Lakshmi Provision Store", category: "groceries", area: "Mylapore", score: 97, tier: "Trusted", completed: 42, disputesLost: 1, repeatCustomers: 9, customerOrders: 3 },
                 { shopId: "low", name: "Low", category: "organic", area: "x", score: 30, tier: "Growing", completed: 1, disputesLost: 3, repeatCustomers: 0, customerOrders: 3 }],
  };
  const good = { shopId: "shop1", message: "Asha loves it. Trust score 97 after 42 orders, and $2 off your first order.", source: "gemini" as const };
  const stub = (res: () => { status?: number; json?: unknown } | Error) => {
    const seen: any[] = [];
    const f = (async (url: string, init: any) => { seen.push({ url, init }); const r = res(); if (r instanceof Error) throw r; return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 }); }) as any;
    return { f, seen };
  };
  const remote = (f: any, errors: unknown[] = []) => new RemoteRecommender("http://agents:8001/", "k3y", new LocalRecommender(), (e) => errors.push(e), f);

  it("sends the camelCase request with the shared secret and returns the service's message", async () => {
    const s = stub(() => ({ json: good }));
    const r = await remote(s.f).run(input);
    expect(r).toEqual(good);
    expect(s.seen[0].url).toBe("http://agents:8001/recommend");
    expect(s.seen[0].init.headers["x-agents-key"]).toBe("k3y");
    expect(JSON.parse(s.seen[0].init.body)).toMatchObject({ referrerName: "Asha", welcomeCents: 200, minTrust: 60 });
  });
  it("rejects invented facts, ineligible picks, links and bad shapes, then uses the offline recommender", async () => {
    const bad = [
      { ...good, message: "Rated 4.9 stars by 500 customers" },
      { ...good, shopId: "low" },
      { ...good, shopId: "not-offered" },
      { ...good, message: "Visit www.shop.com today" },
      { ...good, message: "Mail me a@b.in" },
      { ...good, message: "x".repeat(401) },
      { nonsense: true },
    ];
    for (const j of bad) {
      const errors: unknown[] = [];
      const r = await remote(stub(() => ({ json: j })).f, errors).run(input);
      expect(r.source).toBe("scripted");
      expect(r.shopId).toBe("shop1");
      expect(errors).toHaveLength(1);
    }
  });
  it("falls back on HTTP errors and network failures", async () => {
    for (const res of [() => ({ status: 500 }), () => new Error("ECONNREFUSED")]) {
      const errors: unknown[] = [];
      expect((await remote(stub(res as any).f, errors).run(input)).source).toBe("scripted");
      expect(errors).toHaveLength(1);
    }
  });
  it("checkRecommendation allows only the facts it was given", () => {
    expect(() => checkRecommendation({ ...good, message: "Trust score 97, 42 orders, 1 lost dispute, 9 repeat, $2.00 off" }, input)).not.toThrow();
    expect(() => checkRecommendation({ ...good, message: "Trust score 98" }, input)).toThrow(/not facts/);
  });
  it("is offline unless AGENTS_URL is set", () => {
    expect(makeRecommender({})).toBeInstanceOf(LocalRecommender);
    expect(makeRecommender({ AGENTS_URL: "http://x" })).toBeInstanceOf(RemoteRecommender);
  });
  it("the whole draft flow works through a service stand-in", async () => {
    const s = stub(() => ({ json: { shopId: "shop1", message: "Asha swears by it: trust score 97, 44 completed orders, $2 off.", source: "gemini" } }));
    const t = setup({ recommender: remote(s.f) });
    const a = await t.regular();
    const d = t.J(await t.post(`/api/customers/${a.id}/refer`, { needs: "monthly rice" }));
    expect(d.source).toBe("gemini");
    expect(JSON.parse(s.seen[0].init.body).candidates).toHaveLength(1);
    expect(JSON.parse(s.seen[0].init.body).needs).toBe("monthly rice");
  });
});