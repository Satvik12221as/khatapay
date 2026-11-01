import { describe, it, expect } from "vitest";
import { DEFAULT_POLICY as P, canClaim, canRefer, canReward, discountKeyChars, policyFromEnv, usd } from "../src/referrals/rules";

const claim = (o: Partial<Parameters<typeof canClaim>[0]> = {}) =>
  canClaim({ selfReferral: false, refereeHasPriorOrder: false, refereeHasOpenReferral: false, amountCents: 1500, shopTrust: 90, referrerOrders: 3, referrerHasEmail: true, ...o }, P);
const reward = (o: Partial<Parameters<typeof canReward>[0]> = {}) =>
  canReward({ state: "RELEASED", disputed: false, amountCents: 1500, ageDays: 1, rewardsLast30d: 0, rewardedCents: 0, ...o }, P);
const why = (c: { ok: boolean; reason?: string }) => (c.ok ? "ok" : c.reason);

describe("canRefer", () => {
  it("needs a PayPal email, enough orders and a trusted shop", () => {
    expect(canRefer({ orders: 2, hasEmail: true, shopTrust: 60 }, P).ok).toBe(true);
    expect(why(canRefer({ orders: 2, hasEmail: false, shopTrust: 90 }, P))).toContain("PayPal email");
    expect(why(canRefer({ orders: 1, hasEmail: true, shopTrust: 90 }, P))).toContain("Complete 2 orders");
    expect(why(canRefer({ orders: 5, hasEmail: true, shopTrust: 59 }, P))).toContain("below 60");
  });
});

describe("canClaim", () => {
  it("accepts a clean first order", () => expect(claim().ok).toBe(true));
  it("blocks self-referral, repeat customers and double referrals", () => {
    expect(why(claim({ selfReferral: true }))).toContain("own referral");
    expect(why(claim({ refereeHasPriorOrder: true }))).toContain("first orders");
    expect(why(claim({ refereeHasOpenReferral: true }))).toContain("in progress");
  });
  it("blocks a referrer who is no longer eligible, a low-trust shop and a small order", () => {
    expect(why(claim({ referrerOrders: 1 }))).toContain("no longer available");
    expect(why(claim({ referrerHasEmail: false }))).toContain("no longer available");
    expect(why(claim({ shopTrust: 40 }))).toContain("no longer available");
    expect(why(claim({ amountCents: 999 }))).toContain("at least $10");
    expect(claim({ amountCents: 1000 }).ok).toBe(true);
  });
});

describe("canReward", () => {
  it("pays a completed, undisputed order", () => expect(reward().ok).toBe(true));
  it("never pays for unfinished, refunded or disputed orders", () => {
    for (const state of ["HELD", "REFUNDED", "CANCELLED", "FAILED"]) expect(why(reward({ state }))).toContain("not completed");
    expect(why(reward({ disputed: true }))).toContain("disputed");
  });
  it("enforces the minimum order, expiry and both caps", () => {
    expect(why(reward({ amountCents: 900 }))).toContain("below $10");
    expect(why(reward({ ageDays: 31 }))).toContain("expired");
    expect(reward({ ageDays: 30 }).ok).toBe(true);
    expect(why(reward({ rewardsLast30d: 5 }))).toContain("monthly");
    expect(reward({ rewardsLast30d: 4 }).ok).toBe(true);
    expect(why(reward({ rewardedCents: 2800 }))).toContain("lifetime");
    expect(reward({ rewardedCents: 2700 }).ok).toBe(true);
  });
});

describe("helpers", () => {
  it("turns the welcome discount into key presses", () => {
    expect(discountKeyChars(200).join("")).toBe("-2");
    expect(discountKeyChars(250).join("")).toBe("-2.5");
    expect(discountKeyChars(1000).join("")).toBe("-10");
    expect(discountKeyChars(0)).toEqual([]);
  });
  it("reads policy overrides from the environment and ignores junk", () => {
    expect(policyFromEnv({ REFERRAL_MIN_ORDERS: "1", REFERRAL_REWARD_CENTS: "500" })).toMatchObject({ minOrdersToRefer: 1, rewardCents: 500, minTrust: 60 });
    expect(policyFromEnv({ REFERRAL_MIN_ORDERS: "abc", REFERRAL_MIN_TRUST: "-5" })).toMatchObject({ minOrdersToRefer: 2, minTrust: 60 });
    expect(usd(250)).toBe("$2.50");
    expect(usd(300)).toBe("$3");
  });
});