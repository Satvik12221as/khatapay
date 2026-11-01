/** All referral rules. Plain code, no AI. Every rule returns a reason a human can read. */
export interface ReferralPolicy {
  minOrdersToRefer: number;   // a "regular" has completed at least this many orders at the shop
  minTrust: number;           // shops below this trust score are never recommended
  minOrderCents: number;      // the friend's first order must be at least this much (after the welcome discount)
  welcomeCents: number;       // the friend's welcome discount
  rewardCents: number;        // what the referrer is paid
  maxRewardsPer30d: number;
  lifetimeCapCents: number;
  expiryDays: number;
}

export const DEFAULT_POLICY: ReferralPolicy = {
  minOrdersToRefer: 2, minTrust: 60, minOrderCents: 1000, welcomeCents: 200, rewardCents: 300,
  maxRewardsPer30d: 5, lifetimeCapCents: 3000, expiryDays: 30,
};

const int = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};
export function policyFromEnv(env: Record<string, string | undefined> = {}): ReferralPolicy {
  const d = DEFAULT_POLICY;
  return {
    ...d,
    minOrdersToRefer: int(env.REFERRAL_MIN_ORDERS, d.minOrdersToRefer),
    minTrust: int(env.REFERRAL_MIN_TRUST, d.minTrust),
    minOrderCents: int(env.REFERRAL_MIN_ORDER_CENTS, d.minOrderCents),
    welcomeCents: int(env.REFERRAL_WELCOME_CENTS, d.welcomeCents),
    rewardCents: int(env.REFERRAL_REWARD_CENTS, d.rewardCents),
  };
}

export type Check = { ok: true } | { ok: false; reason: string };
const ok = (): Check => ({ ok: true });
const no = (reason: string): Check => ({ ok: false, reason });
export const usd = (c: number) => "$" + (c / 100).toFixed(2).replace(/\.00$/, "");

/** May this customer recommend this shop? */
export function canRefer(i: { orders: number; hasEmail: boolean; shopTrust: number }, p: ReferralPolicy): Check {
  if (!i.hasEmail) return no("Add your PayPal email so we can pay your reward.");
  if (i.orders < p.minOrdersToRefer) return no(`Complete ${p.minOrdersToRefer} orders here to refer friends (you have ${i.orders}).`);
  if (i.shopTrust < p.minTrust) return no(`This shop's trust score is below ${p.minTrust}.`);
  return ok();
}

/** May this friend use this referral on this order? */
export function canClaim(i: {
  selfReferral: boolean; refereeHasPriorOrder: boolean; refereeHasOpenReferral: boolean; amountCents: number;
  shopTrust: number; referrerOrders: number; referrerHasEmail: boolean;
}, p: ReferralPolicy): Check {
  if (i.selfReferral) return no("You can't use your own referral.");
  if (i.refereeHasPriorOrder) return no("Referrals are for first orders only.");
  if (i.refereeHasOpenReferral) return no("You already have a referral in progress.");
  const r = canRefer({ orders: i.referrerOrders, hasEmail: i.referrerHasEmail, shopTrust: i.shopTrust }, p);
  if (!r.ok) return no("This referral is no longer available.");
  if (i.amountCents < p.minOrderCents) return no(`The order must be at least ${usd(p.minOrderCents)} to use a referral.`);
  return ok();
}

/** Should the referrer be paid now? Called once the friend's order has finished. */
export function canReward(i: {
  state: string; disputed: boolean; amountCents: number; ageDays: number; rewardsLast30d: number; rewardedCents: number;
}, p: ReferralPolicy): Check {
  if (i.state !== "RELEASED") return no("The order was not completed.");
  if (i.disputed) return no("The order was disputed, so no reward is paid.");
  if (i.amountCents < p.minOrderCents) return no(`The order was below ${usd(p.minOrderCents)}.`);
  if (i.ageDays > p.expiryDays) return no("The referral expired.");
  if (i.rewardsLast30d >= p.maxRewardsPer30d) return no("The referrer reached the monthly reward limit.");
  if (i.rewardedCents + p.rewardCents > p.lifetimeCapCents) return no("The referrer reached the lifetime reward limit.");
  return ok();
}

/** The welcome discount as keypad key presses, e.g. 200 -> ["-","2"]. The discount is typed onto the tape. */
export function discountKeyChars(cents: number): string[] {
  if (cents <= 0) return [];
  return ["-", ...(cents / 100).toFixed(2).replace(/\.?0+$/, "").split("")];
}