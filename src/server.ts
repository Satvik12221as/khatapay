import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { fatFingerCheck } from "./keypad/keypad";
import { ALL_KEYS, replay } from "./payments/replay";
import { tapeHash } from "./payments/tape";
import { PaymentStore } from "./payments/store";
import { PaymentEngine } from "./payments/engine";
import { IllegalTransition } from "./payments/states";
import { MERCHANTS } from "./merchants";
import { makePayPal, PayPalError, type PayPal } from "./paypal/client";
import { discountKeys } from "./haggle/haggle";
import { makeNegotiator, type Negotiator } from "./agents/negotiator";
import { makePanel, type Panel } from "./agents/panel";
import { makeRecommender } from "./agents/recommender";
import { ScriptedPriceBrain } from "./agents/pricecheck_local";
import { makeInsightsClient, type InsightsResult } from "./agents/insights";
import { makeInvoiceClient, type InvoiceResult } from "./agents/invoice";
import { makeMerchantClient, type MerchantFindResult } from "./agents/merchant";
import { ReferralStore } from "./referrals/store";
import { ReferralService } from "./referrals/service";
import { registerReferralRoutes } from "./referrals/routes";
import { policyFromEnv } from "./referrals/rules";
import { trustScore, statsFor } from "./trust/trust";

const CURRENCY = "USD";
const MAX_PAYMENT_CENTS = 100_000; // 1,000.00 hard cap for now

export function buildApp(env: Record<string, string | undefined> = process.env, paypal?: PayPal, negotiatorOverride?: Negotiator, panelOverride?: Panel) {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });
  const pp = paypal ?? makePayPal(env);
  const warn = (e: unknown) => app.log.warn({ err: String(e) }, "Agent service unavailable or rejected, using offline agents");
  const negotiator = negotiatorOverride ?? makeNegotiator(env, warn);
  const panel = panelOverride ?? makePanel(env, warn);
  const store = new PaymentStore(env.DATA_FILE || undefined);
  const payoutEmail = env.SHOP_PAYOUT_EMAIL || (pp.mode === "mock" ? "shop-owner@example.com" : undefined);
  const engine = new PaymentEngine(store, pp, panel, payoutEmail);
  const publicUrl = env.PUBLIC_URL ?? "http://localhost:5173";
  const referrals = new ReferralService({
    payments: store, pp,
    store: new ReferralStore(env.REFERRALS_FILE || undefined),
    recommender: makeRecommender(env, warn),
    merchants: MERCHANTS, policy: policyFromEnv(env),
    });
  registerReferralRoutes(app, referrals);

  // One shared budget for all AI calls (protects your Gemini quota on a public demo).
  const aiLog: number[] = [];
  const aiMax = Number(env.HAGGLE_MAX_PER_HOUR ?? 60);
  const aiAllowed = () => {
    const now = Date.now();
    while (aiLog.length && now - aiLog[0] > 3_600_000) aiLog.shift();
    if (aiLog.length >= aiMax) return false;
    aiLog.push(now);
    return true;
  };

  const merchant = (id: string) => {
    const m = MERCHANTS.find((x) => x.id === id);
    if (!m) throw Object.assign(new Error("Unknown shop"), { statusCode: 404 });
    return m;
  };

  const priceCheck = (req: { merchantId: string; lines: { expr: string; cents: number }[] }, typicalCents: number | null) => {
    return ScriptedPriceBrain(typicalCents)({
      merchantName: merchant(req.merchantId).name,
      totalCents: req.lines.reduce((a, l) => a + l.cents, 0),
      lines: req.lines,
      category: merchant(req.merchantId).category,
      area: merchant(req.merchantId).area,
    });
  };

  const insightsClient = makeInsightsClient(env, warn);
  const invoiceClient = makeInvoiceClient(env, warn);
  const merchantClient = makeMerchantClient(env, warn);

  app.setErrorHandler((err: any, _req, reply) => {
    if (err.name === "ZodError") return reply.code(400).send({ error: "BAD_REQUEST", message: "Invalid request", issues: err.issues });
    if (err instanceof IllegalTransition) return reply.code(409).send({ error: "ILLEGAL_STEP", message: err.message });
    if (err instanceof PayPalError) {
      app.log.error({ debugId: err.debugId, body: err.body }, "PayPal error");
      return reply.code(502).send({ error: "PAYPAL", message: err.message, debugId: err.debugId });
    }
    reply.code(err.statusCode ?? 500).send({ error: "ERROR", message: err.message });
  });

  app.get("/health", async () => ({ ok: true, paypal: pp.mode }));
  app.get("/api/merchants", async () => MERCHANTS);

  /** Start a payment. The browser sends KEYS, never a total. */
  app.post("/api/pay", async (req, reply) => {
    const body = z.object({
      merchantId: z.string(),
      keys: z.array(z.enum(ALL_KEYS)).max(300),
      confirmedLarge: z.boolean().default(false),
    }).parse(req.body);

    const m = merchant(body.merchantId);
    const view = replay(body.keys);
    if (!view.canPay || view.totalCents === null) {
      return reply.code(422).send({ error: "NOT_PAYABLE", message: view.error ?? "Enter a complete sum above zero" });
    }
    if (view.totalCents > MAX_PAYMENT_CENTS) {
      return reply.code(403).send({ error: "LIMIT", message: "Above the per-payment limit" });
    }
    const ff = fatFingerCheck(view.totalCents, m.typicalCents);
    if (ff.suspicious && !body.confirmedLarge) {
      return reply.code(409).send({ error: "FAT_FINGER", reason: ff.reason, suggestionCents: ff.suggestionCents });
    }

    const id = randomUUID();
    const hash = tapeHash({ merchantId: m.id, currency: CURRENCY, lines: view.lines, totalCents: view.totalCents });
    const order = await pp.createOrder({
      paymentId: id, merchantName: m.name, currency: CURRENCY, totalCents: view.totalCents, lines: view.lines, tapeHash: hash,
      requestId: `khatapay-${id}-order`,
      returnUrl: `${publicUrl}/pay/return?payment=${id}`,
      cancelUrl: `${publicUrl}/pay/cancel?payment=${id}`,
    });
    engine.create({ id, merchantId: m.id, merchantName: m.name, amountCents: view.totalCents, currency: CURRENCY, lines: view.lines, tapeHash: hash, orderId: order.id, createdAt: new Date().toISOString() });
    return { paymentId: id, approvalUrl: order.approvalUrl, totalCents: view.totalCents, tapeHash: hash };
  });

  /** PayPal sends the buyer back here after they approve. We capture and HOLD the money. */
  app.get("/pay/return", async (req, reply) => {
    const q = z.object({ payment: z.string(), token: z.string() }).parse(req.query);
    const p = engine.get(q.payment);
    if (q.token !== p.orderId) return reply.code(400).send({ error: "ORDER_MISMATCH", message: "That approval does not belong to this payment" });
    const after = await engine.capture(p.id);
    if (after.error) app.log.error({ id: after.id, error: after.error }, "capture failed");
    return reply.redirect(after.state === "FAILED" ? `/?failed=${after.id}` : `/?paid=${after.id}`);
  });

  app.get("/pay/cancel", async (req, reply) => {
    const { payment } = z.object({ payment: z.string() }).parse(req.query);
    engine.cancel(payment);
    return reply.redirect(`/?cancelled=${payment}`);
  });

  app.get("/api/payments", async () => store.list());
  app.get("/api/payments/:id", async (req) => engine.get((req.params as { id: string }).id));

  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  app.post("/api/payments/:id/deliver", async (req) => engine.deliver(idOf(req)));
  app.post("/api/payments/:id/confirm", async (req) => engine.confirm(idOf(req)));
  app.post("/api/payments/:id/refund", async (req) => engine.refund(idOf(req)));
  app.post("/api/payments/:id/dispute", async (req) => {
    const b = z.object({ reason: z.enum(["not_received", "wrong_items", "wrong_amount", "other"]), note: z.string().max(200).default("") }).parse(req.body);
    return engine.dispute(idOf(req), b.reason, b.note);
  });
  app.post("/api/payments/:id/respond", async (req) => {
    const b = z.object({ stance: z.enum(["delivered_ok", "agrees_refund"]), note: z.string().max(200).default("") }).parse(req.body);
    return engine.respond(idOf(req), b.stance, b.note);
  });
  app.post("/api/payments/:id/judge", async (req, reply) => {
    if (engine.get(idOf(req)).state === "DISPUTED" && !aiAllowed()) return reply.code(429).send({ error: "RATE_LIMIT", message: "Too many AI requests, try again later" });
    return engine.judge(idOf(req));
  });

  /** Two AI agents negotiate a discount. They only propose; the referee limits them; the human approves. */
  app.post("/api/haggle", async (req, reply) => {
    const body = z.object({ merchantId: z.string(), keys: z.array(z.enum(ALL_KEYS)).max(300) }).parse(req.body);
    const m = merchant(body.merchantId);
    const view = replay(body.keys);
    if (!view.canPay || view.totalCents === null) return reply.code(422).send({ error: "NOT_PAYABLE", message: "Enter a complete sum first" });
    if (view.totalCents < 100) return reply.code(422).send({ error: "TOO_SMALL", message: "Bill is too small to negotiate" });
    if (!aiAllowed()) return reply.code(429).send({ error: "RATE_LIMIT", message: "Too many negotiations, try again later" });

    const out = await negotiator.run({ merchantName: m.name, totalCents: view.totalCents, policy: { maxDiscountPct: m.maxDiscountPct, minTotalCents: 100 }, loyalty: m.loyalty });
    const finalKeys = [...body.keys, ...discountKeys(out.finalDiscountCents)];
    const after = replay(finalKeys);
    if (after.totalCents !== view.totalCents - out.finalDiscountCents) throw new Error("Haggle result did not match the keypad");
    return { ...out, keys: finalKeys, totalBeforeCents: view.totalCents, totalAfterCents: after.totalCents };
  });

  /** Price-check: compare bill against pricebook and typical spend. */
  app.post("/api/pricecheck", async (req, reply) => {
    if (!aiAllowed()) return reply.code(429).send({ error: "RATE_LIMIT", message: "Too many AI requests, try again later" });
    const body = z.object({
      merchantId: z.string(),
      lines: z.array(z.object({ expr: z.string(), cents: z.number().int().min(0) })),
    }).parse(req.body);
    const m = merchant(body.merchantId);
    return priceCheck(body, m.typicalCents);
  });

  /** Merchant Performance Insights: AI-generated recommendations for shop owners. */
  app.get("/api/merchants/:id/insights", async (req, reply) => {
    if (!aiAllowed()) return reply.code(429).send({ error: "RATE_LIMIT", message: "Too many AI requests, try again later" });
    const id = (req.params as { id: string }).id;
    const m = merchant(id);

    // Compute stats from payment history
    const payments = store.list().filter(p => p.merchantId === id);
    const released = payments.filter(p => p.state === "RELEASED");
    const totalRevenueCents = released.reduce((a, p) => a + p.amountCents, 0);
    const avgOrderCents = released.length > 0 ? Math.round(totalRevenueCents / released.length) : 0;
    const disputesOpened = payments.filter(p => p.state === "DISPUTED").length;
    const disputesLost = payments.filter(p => p.dispute?.verdict?.outcome === "refund").length;
    const successRate = payments.length > 0 ? released.length / payments.length : 1;

    // Repeat customer rate
    const perCustomer = new Map<string, number>();
    for (const p of released) {
      const c = store.linkOf(p.id)?.customerId;
      if (c) perCustomer.set(c, (perCustomer.get(c) ?? 0) + 1);
    }
    const repeatCustomerRate = perCustomer.size > 0
      ? [...perCustomer.values()].filter(n => n >= 2).length / perCustomer.size
      : 0;

    // Average response time (mock for now - in reality would come from dispute timestamps)
    const avgResponseTimeHours = 12;

    const result = await insightsClient.run({
      merchantId: m.id,
      merchantName: m.name,
      periodDays: 30,
      totalPayments: payments.length,
      totalRevenueCents,
      avgOrderCents,
      successRate,
      disputesOpened,
      disputesLost,
      repeatCustomerRate,
      avgResponseTimeHours,
    });

    return result;
  });

  /** Invoice Generator: Create professional invoices from payment data. */
  app.post("/api/invoices/generate", async (req, reply) => {
    if (!aiAllowed()) return reply.code(429).send({ error: "RATE_LIMIT", message: "Too many AI requests, try again later" });
    const body = z.object({
      paymentId: z.string(),
      merchant: z.object({
        id: z.string(),
        name: z.string(),
        address: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        gstNumber: z.string().optional(),
      }),
      customer: z.object({
        name: z.string(),
        email: z.string().optional(),
        address: z.string().optional(),
        phone: z.string().optional(),
      }).optional(),
      lineItems: z.array(z.object({
        description: z.string(),
        quantity: z.number().int().min(1),
        unitPriceCents: z.number().int().min(0),
        totalCents: z.number().int().min(0),
        taxCents: z.number().int().min(0).default(0),
        sku: z.string().optional(),
      })).min(1),
      currency: z.string().default("USD"),
      taxRate: z.number().min(0).max(1).default(0),
      dueDate: z.string().optional(),
      notes: z.string().optional(),
      includePaymentLink: z.boolean().default(false),
    }).parse(req.body);

    const result = await invoiceClient.run(body);
    return result;
  });

  /** Merchant Concierge: Help customers find the right shop. */
  app.post("/api/shops/find", async (req, reply) => {
    if (!aiAllowed()) return reply.code(429).send({ error: "RATE_LIMIT", message: "Too many AI requests, try again later" });
    const body = z.object({
      needs: z.string().max(200),
      category: z.string().optional(),
      area: z.string().optional(),
      maxPriceDollars: z.number().min(0).optional(),
      minTrustScore: z.number().int().min(0).max(100).default(0),
      maxResults: z.number().int().min(1).max(20).default(5),
    }).parse(req.body);

    // Prepare candidates from merchant list
    const allPayments = store.list();
    const candidates = MERCHANTS.map(m => {
      const trust = trustScore(statsFor(m.id, allPayments, p => store.linkOf(p)?.customerId, m.history));
      return {
        shopId: m.id,
        name: m.name,
        category: m.category,
        area: m.area,
        score: trust.score,
        tier: trust.tier,
        typicalCents: m.typicalCents,
        customerOrders: m.loyalty.visits,
      };
    });

    const result = await merchantClient.run({
      needs: body.needs,
      category: body.category,
      area: body.area,
      maxPriceDollars: body.maxPriceDollars,
      minTrustScore: body.minTrustScore,
      maxResults: body.maxResults,
      candidates,
    });

    return result;
  });

  return { app, store, pp, engine, referrals };
}

// Start the server only when this file is run directly (not when imported by tests)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, pp } = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info(`KhataPay API on :${port} (PayPal: ${pp.mode})`));
}