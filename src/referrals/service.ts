import type { Merchant } from "../merchants";
import type { PayPal } from "../paypal/client";
import type { Payment, PaymentStore } from "../payments/store";
import { statsFor, trustScore, type Trust } from "../trust/trust";
import { templateMessage, type Candidate, type Recommender } from "../agents/recommender";
import { canClaim, canRefer, canReward, type ReferralPolicy } from "./rules";
import type { Customer, Referral, ReferralStore } from "./store";

export class ReferralError extends Error {
  constructor(public statusCode: number, message: string) { super(message); this.name = "ReferralError"; }
}

const CAPTURED = ["HELD", "FULFILLED", "DISPUTED", "RELEASED", "REFUNDED"];   // money was taken
const UNFINISHED = ["CREATED", "HELD", "FULFILLED", "DISPUTED"];
const DAY = 86_400_000;

export interface ServiceDeps {
  payments: PaymentStore;
  store: ReferralStore;
  pp: Pick<PayPal, "payout">;
  recommender: Recommender;
  merchants: Merchant[];
  policy: ReferralPolicy;
  now?: () => number;
}

export class ReferralService {
  private inFlight = new Set<string>();
  constructor(private d: ServiceDeps) {}
  private now() { return (this.d.now ?? Date.now)(); }
  private get p() { return this.d.policy; }
  private customerOf = (paymentId: string) => this.d.store.linkOf(paymentId)?.customerId;

  private shop(id: string): Merchant {
    const m = this.d.merchants.find((x) => x.id === id);
    if (!m) throw new ReferralError(404, "Unknown shop");
    return m;
  }
  customer(id: string): Customer {
    const c = this.d.store.customer(id);
    if (!c) throw new ReferralError(404, "Unknown customer");
    return c;
  }

  // ---------- trust ----------
  trust(m: Merchant): Trust & { merchantId: string } {
    return { merchantId: m.id, ...trustScore(statsFor(m.id, this.d.payments.list(), this.customerOf, m.history)) };
  }
  trustAll() { return this.d.merchants.map((m) => this.trust(m)); }

  ordersAt(customerId: string, merchantId: string): number {
    return this.d.store.paymentsOf(customerId).filter((l) => l.merchantId === merchantId && this.d.payments.get(l.paymentId)?.state === "RELEASED").length;
  }

  private shopsFor(c: Customer) {
    return this.d.merchants.map((m) => {
      const orders = this.ordersAt(c.id, m.id);
      const trust = this.trust(m);
      return { m, orders, trust, check: canRefer({ orders, hasEmail: !!c.paypalEmail, shopTrust: trust.score }, this.p) };
    });
  }

  // ---------- customers ----------
  createCustomer(name: string, paypalEmail?: string) { return this.d.store.createCustomer(name, paypalEmail); }
  updateProfile(id: string, patch: { name?: string; paypalEmail?: string }) { this.customer(id); return this.d.store.updateCustomer(id, patch); }

  mine(customerId: string) {
    return this.d.store.allReferrals()
      .filter((r) => r.referrerId === customerId || r.refereeId === customerId)
      .map((r) => ({
        id: r.id, role: r.referrerId === customerId ? ("referrer" as const) : ("referee" as const),
        merchantName: this.d.merchants.find((m) => m.id === r.merchantId)?.name ?? r.merchantId,
        state: r.state, welcomeCents: r.welcomeCents, rewardCents: r.rewardCents, reason: r.reason, createdAt: r.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async dashboard(customerId: string) {
    const c = this.customer(customerId);
    await this.syncAll();                                  // retries any reward whose payout failed earlier
    const referrals = this.mine(customerId);
    return {
      customer: { id: c.id, name: c.name, paypalEmail: c.paypalEmail, referralCode: c.referralCode },
      shops: this.shopsFor(c).map((s) => ({ merchantId: s.m.id, name: s.m.name, category: s.m.category, orders: s.orders, trustScore: s.trust.score, tier: s.trust.tier, eligible: s.check.ok, ...(s.check.ok ? {} : { reason: s.check.reason }) })),
      referrals,
      earnedCents: referrals.filter((r) => r.role === "referrer" && r.state === "REWARDED").reduce((a, r) => a + (r.rewardCents ?? 0), 0),
      terms: { ...this.p },
    };
  }

  // ---------- the referral agent ----------
  async draft(customerId: string, needs: string) {
    const c = this.customer(customerId);
    if (!c.paypalEmail) throw new ReferralError(422, "Add your PayPal email so we can pay your reward.");
    const open = this.shopsFor(c).filter((s) => s.check.ok);
    if (!open.length) throw new ReferralError(422, `Complete ${this.p.minOrdersToRefer} orders at a shop with a trust score of ${this.p.minTrust} or more to unlock referrals.`);
    const candidates: Candidate[] = open.map((s) => ({
      shopId: s.m.id, name: s.m.name, category: s.m.category, area: s.m.area, score: s.trust.score, tier: s.trust.tier,
      completed: s.trust.stats.completed, disputesLost: s.trust.stats.disputesLost, repeatCustomers: s.trust.stats.repeatCustomers, customerOrders: s.orders,
    }));
    const rec = await this.d.recommender.run({ referrerName: c.name, needs: needs.slice(0, 200), welcomeCents: this.p.welcomeCents, rewardCents: this.p.rewardCents, minTrust: this.p.minTrust, candidates });
    const pick = open.find((s) => s.m.id === rec.shopId)!;
    this.d.store.setPitch(c.id, pick.m.id, rec.message);
    return {
      merchantId: pick.m.id, merchantName: pick.m.name, message: rec.message, source: rec.source,
      code: c.referralCode, path: `/?ref=${c.referralCode}&shop=${pick.m.id}`,
      trust: { score: pick.trust.score, tier: pick.trust.tier, explanation: pick.trust.explanation },
      welcomeCents: this.p.welcomeCents, rewardCents: this.p.rewardCents, minOrderCents: this.p.minOrderCents,
    };
  }

  /** What a friend sees when they open a referral link. Public: no customer details beyond the referrer's first name. */
  landing(code: string, shopId: string) {
    const referrer = this.d.store.findByCode(code.trim().toUpperCase());
    if (!referrer) throw new ReferralError(404, "Unknown referral code");
    const m = this.shop(shopId);
    const t = this.trust(m);
    const orders = this.ordersAt(referrer.id, m.id);
    if (!canRefer({ orders, hasEmail: !!referrer.paypalEmail, shopTrust: t.score }, this.p).ok) return { valid: false as const, reason: "This referral is no longer available." };
    const cand: Candidate = { shopId: m.id, name: m.name, category: m.category, area: m.area, score: t.score, tier: t.tier, completed: t.stats.completed, disputesLost: t.stats.disputesLost, repeatCustomers: t.stats.repeatCustomers, customerOrders: orders };
    return {
      valid: true as const, referrerName: referrer.name, merchantId: m.id, merchantName: m.name, category: m.category, area: m.area,
      trust: { score: t.score, tier: t.tier, explanation: t.explanation }, welcomeCents: this.p.welcomeCents, minOrderCents: this.p.minOrderCents,
      message: this.d.store.pitch(referrer.id, m.id) ?? templateMessage(referrer.name, cand, this.p.welcomeCents),
    };
  }

  // ---------- linking a payment to a customer, and claiming a referral ----------
  link(customerId: string, paymentId: string, code?: string) {
    const c = this.customer(customerId);
    const pay = this.d.payments.get(paymentId);
    if (!pay) throw new ReferralError(404, "Unknown payment");
    const existing = this.d.store.linkOf(paymentId);
    if (existing && existing.customerId !== customerId) throw new ReferralError(409, "This payment belongs to another customer.");
    if (!existing) this.d.store.link(paymentId, customerId, pay.merchantId);
    if (!code) return { linked: true as const };
    const res = this.claim(c, pay, code);
    return res.referral
      ? { linked: true as const, referral: { id: res.referral.id, state: res.referral.state, welcomeCents: res.referral.welcomeCents } }
      : { linked: true as const, referralRejected: res.rejected };
  }

  private claim(referee: Customer, pay: Payment, code: string): { referral?: Referral; rejected?: string } {
    const already = this.d.store.referralByPayment(pay.id);
    if (already) return { referral: already };
    const referrer = this.d.store.findByCode(code.trim().toUpperCase());
    if (!referrer) return { rejected: "Unknown referral code." };
    const m = this.shop(pay.merchantId);
    const sameEmail = !!referrer.paypalEmail && !!referee.paypalEmail && referrer.paypalEmail.toLowerCase() === referee.paypalEmail.toLowerCase();
    const check = canClaim({
      selfReferral: referrer.id === referee.id || sameEmail,
      refereeHasPriorOrder: this.d.store.paymentsOf(referee.id).some((l) => l.paymentId !== pay.id && CAPTURED.includes(this.d.payments.get(l.paymentId)?.state ?? "")),
      refereeHasOpenReferral: this.d.store.allReferrals().some((r) => r.refereeId === referee.id && r.state !== "VOID"),
      amountCents: pay.amountCents, shopTrust: this.trust(m).score,
      referrerOrders: this.ordersAt(referrer.id, m.id), referrerHasEmail: !!referrer.paypalEmail,
    }, this.p);
    if (!check.ok) return { rejected: check.reason };
    return { referral: this.d.store.addReferral({ referrerId: referrer.id, refereeId: referee.id, merchantId: m.id, paymentId: pay.id, welcomeCents: this.p.welcomeCents }) };
  }

  // ---------- settlement: pay the referrer only when the friend's order has really finished ----------
  async sync(paymentId: string): Promise<void> {
    const r = this.d.store.pendingForPayment(paymentId);
    const pay = this.d.payments.get(paymentId);
    if (!r || !pay || UNFINISHED.includes(pay.state) || this.inFlight.has(r.id)) return;
    this.inFlight.add(r.id);
    try {
      const settledAt = new Date(this.now()).toISOString();
      const referrer = this.d.store.customer(r.referrerId);
      const rewarded = this.d.store.allReferrals().filter((x) => x.referrerId === r.referrerId && x.state === "REWARDED");
      const check = canReward({
        state: pay.state, disputed: !!pay.dispute, amountCents: pay.amountCents,
        ageDays: (this.now() - Date.parse(r.createdAt)) / DAY,
        rewardsLast30d: rewarded.filter((x) => this.now() - Date.parse(x.settledAt ?? x.createdAt) <= 30 * DAY).length,
        rewardedCents: rewarded.reduce((a, x) => a + (x.rewardCents ?? 0), 0),
      }, this.p);
      if (!check.ok) { this.d.store.updateReferral(r.id, { state: "VOID", reason: check.reason, settledAt }); return; }
      if (!referrer?.paypalEmail) { this.d.store.updateReferral(r.id, { state: "VOID", reason: "The referrer has no PayPal email.", settledAt }); return; }
      const po = await this.d.pp.payout({ email: referrer.paypalEmail, amountCents: this.p.rewardCents, currency: pay.currency, note: "KhataPay referral reward", batchId: `khatapay-referral-${r.id}-reward` });
      this.d.store.updateReferral(r.id, { state: "REWARDED", rewardCents: this.p.rewardCents, payoutId: po.batchId, settledAt });
    } finally {
      this.inFlight.delete(r.id);
    }
  }

  async syncAll(): Promise<void> {
    for (const r of this.d.store.allReferrals().filter((x) => x.state === "PENDING")) {
      try { await this.sync(r.paymentId); } catch { /* a failed payout stays PENDING and is retried next time */ }
    }
  }
}