import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { fatFingerCheck } from "./keypad/keypad";
import { ALL_KEYS, replay } from "./payments/replay";
import { tapeHash } from "./payments/tape";
import { PaymentStore } from "./payments/store";
import { MERCHANTS } from "./merchants";
import { makePayPal, PayPalError, type PayPal } from "./paypal/client";
import { makeBrain, type Brain } from "./haggle/brains";
import { negotiate, discountKeys } from "./haggle/haggle";

const CURRENCY = "USD";
const MAX_PAYMENT_CENTS = 100_000; // 1,000.00 hard cap for now (guardrails grow in Phase 4)

export function buildApp(env: Record<string, string | undefined> = process.env, paypal?: PayPal, brainOverride?: Brain) {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });
  const pp = paypal ?? makePayPal(env);
  const store = new PaymentStore();
  const publicUrl = env.PUBLIC_URL ?? "http://localhost:5173";
  const brain = brainOverride ?? makeBrain(env, (e) => app.log.warn({ err: String(e) }, "Gemini failed, using offline agents"));
  const haggleLog: number[] = [];
  const haggleMax = Number(env.HAGGLE_MAX_PER_HOUR ?? 60);

  const merchant = (id: string) => {
    const m = MERCHANTS.find((x) => x.id === id);
    if (!m) throw Object.assign(new Error("Unknown shop"), { statusCode: 404 });
    return m;
  };

  app.setErrorHandler((err: any, _req, reply) => {
    if (err.name === "ZodError") return reply.code(400).send({ error: "BAD_REQUEST", message: "Invalid request", issues: err.issues });
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
    const view = replay(body.keys);                       // server recomputes everything
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
    store.add({ id, merchantId: m.id, merchantName: m.name, amountCents: view.totalCents, currency: CURRENCY, lines: view.lines, tapeHash: hash, state: "CREATED", orderId: order.id, createdAt: new Date().toISOString() });
    return { paymentId: id, approvalUrl: order.approvalUrl, totalCents: view.totalCents, tapeHash: hash };
  });

  /** PayPal sends the buyer back here after they approve. We capture the money. */
  app.get("/pay/return", async (req, reply) => {
    const q = z.object({ payment: z.string(), token: z.string() }).parse(req.query);
    const p = store.get(q.payment);
    if (!p) return reply.code(404).send({ error: "NOT_FOUND", message: "Unknown payment" });
    if (q.token !== p.orderId) return reply.code(400).send({ error: "ORDER_MISMATCH", message: "That approval does not belong to this payment" });
    if (p.state === "PAID") return reply.redirect(`/?paid=${p.id}`);
    if (p.state !== "CREATED") return reply.redirect(`/?failed=${p.id}`);
    try {
      const cap = await pp.captureOrder(p.orderId, `khatapay-${p.id}-capture`);
      if (cap.status === "COMPLETED") {
        store.update(p.id, { state: "PAID", captureId: cap.captureId });
        return reply.redirect(`/?paid=${p.id}`);
      }
      store.update(p.id, { state: "FAILED", error: `Capture status ${cap.status}` });
    } catch (e: any) {
      store.update(p.id, { state: "FAILED", error: e.message });
      app.log.error(e);
    }
    return reply.redirect(`/?failed=${p.id}`);
  });

  app.get("/pay/cancel", async (req, reply) => {
    const { payment } = z.object({ payment: z.string() }).parse(req.query);
    const p = store.get(payment);
    if (p && p.state === "CREATED") store.update(p.id, { state: "CANCELLED" });
    return reply.redirect(`/?cancelled=${payment}`);
  });

  app.get("/api/payments/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = store.get(id);
    if (!p) return reply.code(404).send({ error: "NOT_FOUND", message: "Unknown payment" });
    return p;
  });
    /** Two AI agents negotiate a discount. They only propose; the referee limits them; the human approves. */
  app.post("/api/haggle", async (req, reply) => {
    const body = z.object({ merchantId: z.string(), keys: z.array(z.enum(ALL_KEYS)).max(300) }).parse(req.body);
    const m = merchant(body.merchantId);
    const view = replay(body.keys);
    if (!view.canPay || view.totalCents === null) return reply.code(422).send({ error: "NOT_PAYABLE", message: "Enter a complete sum first" });
    if (view.totalCents < 100) return reply.code(422).send({ error: "TOO_SMALL", message: "Bill is too small to negotiate" });
    const now = Date.now();
    while (haggleLog.length && now - haggleLog[0] > 3_600_000) haggleLog.shift();
    if (haggleLog.length >= haggleMax) return reply.code(429).send({ error: "RATE_LIMIT", message: "Too many negotiations, try again later" });
    haggleLog.push(now);

    const out = await negotiate({ brain, merchantName: m.name, totalCents: view.totalCents, policy: { maxDiscountPct: m.maxDiscountPct, minTotalCents: 100 }, loyalty: m.loyalty });
    const finalKeys = [...body.keys, ...discountKeys(out.finalDiscountCents)];
    const after = replay(finalKeys);
    if (after.totalCents !== view.totalCents - out.finalDiscountCents) throw new Error("Haggle result did not match the keypad");
    return { ...out, keys: finalKeys, totalBeforeCents: view.totalCents, totalAfterCents: after.totalCents };
  });
  return { app, store, pp };
}

// Start the server only when this file is run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, pp } = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info(`KhataPay API on :${port} (PayPal: ${pp.mode})`));
}