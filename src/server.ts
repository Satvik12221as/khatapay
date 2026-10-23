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
import { makeBrain, type Brain } from "./haggle/brains";
import { negotiate, discountKeys } from "./haggle/haggle";
import { makeJudge, type JudgeBrain } from "./judge/judges";

const CURRENCY = "USD";
const MAX_PAYMENT_CENTS = 100_000; // 1,000.00 hard cap for now

export function buildApp(env: Record<string, string | undefined> = process.env, paypal?: PayPal, brainOverride?: Brain, judgeOverride?: JudgeBrain) {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });
  const pp = paypal ?? makePayPal(env);
  const warn = (e: unknown) => app.log.warn({ err: String(e) }, "Gemini failed, using offline agents");
  const brain = brainOverride ?? makeBrain(env, warn);
  const judges = judgeOverride ?? makeJudge(env, warn);
  const store = new PaymentStore(env.DATA_FILE || undefined);
  const payoutEmail = env.SHOP_PAYOUT_EMAIL || (pp.mode === "mock" ? "shop-owner@example.com" : undefined);
  const engine = new PaymentEngine(store, pp, judges, payoutEmail);
  const publicUrl = env.PUBLIC_URL ?? "http://localhost:5173";

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

    const out = await negotiate({ brain, merchantName: m.name, totalCents: view.totalCents, policy: { maxDiscountPct: m.maxDiscountPct, minTotalCents: 100 }, loyalty: m.loyalty });
    const finalKeys = [...body.keys, ...discountKeys(out.finalDiscountCents)];
    const after = replay(finalKeys);
    if (after.totalCents !== view.totalCents - out.finalDiscountCents) throw new Error("Haggle result did not match the keypad");
    return { ...out, keys: finalKeys, totalBeforeCents: view.totalCents, totalAfterCents: after.totalCents };
  });

  return { app, store, pp, engine };
}

// Start the server only when this file is run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { app, pp } = buildApp();
  const port = Number(process.env.PORT ?? 3000);
  app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info(`KhataPay API on :${port} (PayPal: ${pp.mode})`));
}