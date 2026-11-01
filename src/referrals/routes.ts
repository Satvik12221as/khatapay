import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ReferralService } from "./service";

const email = z.string().trim().email().max(120);

/**
 * Registers the customer, trust and referral routes.
 * IMPORTANT: call this BEFORE the other routes, so the settlement hook covers them.
 */
export function registerReferralRoutes(app: FastifyInstance, svc: ReferralService) {
  // After any payment route that can finish a payment, pay or void the matching referral.
  app.addHook("onSend", async (req, reply, payload) => {
    const url = req.routeOptions?.url ?? "";
    let id: string | undefined;
    if (/^\/api\/payments\/:id\/(confirm|refund|judge)$/.test(url)) id = (req.params as { id?: string }).id;
    else if (url === "/pay/return" || url === "/pay/cancel") id = (req.query as { payment?: string }).payment;
    if (id && reply.statusCode < 400) {
      try { await svc.sync(id); } catch (e) { app.log.error({ err: String(e) }, "referral settlement failed"); }
    }
    return payload;
  });

  app.get("/api/trust", async () => svc.trustAll());

  app.post("/api/customers", async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(40).default("Guest"), paypalEmail: email.optional() }).parse(req.body ?? {});
    return svc.createCustomer(b.name, b.paypalEmail);
  });
  app.get("/api/customers/:id", async (req) => svc.dashboard((req.params as { id: string }).id));
  app.post("/api/customers/:id/profile", async (req) => {
    const b = z.object({ name: z.string().trim().min(1).max(40).optional(), paypalEmail: email.optional() }).parse(req.body ?? {});
    return svc.updateProfile((req.params as { id: string }).id, b);
  });
  app.post("/api/customers/:id/link", async (req) => {
    const b = z.object({ paymentId: z.string().max(80), referralCode: z.string().trim().max(20).optional() }).parse(req.body);
    return svc.link((req.params as { id: string }).id, b.paymentId, b.referralCode);
  });
  app.post("/api/customers/:id/refer", async (req) => {
    const b = z.object({ needs: z.string().max(200).default("") }).parse(req.body ?? {});
    return svc.draft((req.params as { id: string }).id, b.needs);
  });
  app.get("/api/referrals/landing", async (req) => {
    const q = z.object({ code: z.string().max(20), shop: z.string().max(40) }).parse(req.query);
    return svc.landing(q.code, q.shop);
  });
}