import { describe, it, expect } from "vitest";
import { negotiate, discountKeys, capFor } from "../src/haggle/haggle";
import { GeminiBrain, ResilientBrain, ScriptedBrain, makeBrain, type Brain, type Ctx, type Decision } from "../src/haggle/brains";
import { buildApp } from "../src/server";
import { MockPayPal } from "../src/paypal/client";
import { replay } from "../src/payments/replay";
import type { Key } from "../src/keypad/keypad";

const K = (s: string) => s.replace(/\*/g, "×").replace(/\//g, "÷").split("") as Key[];
const policy = { maxDiscountPct: 10, minTotalCents: 100 };
const regular = { visits: 14, memberSince: "March", onTimeRate: 1 };
const run = (brain: Brain, total = 9000) => negotiate({ brain, merchantName: "Shop", totalCents: total, policy, loyalty: regular });

describe("discountKeys", () => {
  it("turns cents into key presses", () => {
    expect(discountKeys(700).join("")).toBe("-7");
    expect(discountKeys(750).join("")).toBe("-7.5");
    expect(discountKeys(725).join("")).toBe("-7.25");
    expect(discountKeys(1000).join("")).toBe("-10");
    expect(discountKeys(10000).join("")).toBe("-100");
    expect(discountKeys(0)).toEqual([]);
  });
});

describe("capFor", () => {
  it("is the smaller of the percentage cap and keeping a minimum total", () => {
    expect(capFor(9000, policy)).toBe(900);
    expect(capFor(150, policy)).toBe(15);
    expect(capFor(100, policy)).toBe(0);
  });
});

describe("negotiation with rule-based agents", () => {
  it("a loyal regular gets a deal between the shop's comfort and its cap", async () => {
    const o = await run(new ScriptedBrain());
    expect(o.turns.map((t) => t.side)).toEqual(["customer", "shop", "customer", "shop"]);
    expect(o.finalDiscountCents).toBeGreaterThanOrEqual(450);
    expect(o.finalDiscountCents).toBeLessThanOrEqual(900);
    expect(o.agreed).toBe(true);
  });
  it("a new customer gets a smaller discount than a regular", async () => {
    const newbie = await negotiate({ brain: new ScriptedBrain(), merchantName: "S", totalCents: 9000, policy, loyalty: { visits: 1, memberSince: "today", onTimeRate: 1 } });
    expect(newbie.finalDiscountCents).toBeLessThan((await run(new ScriptedBrain())).finalDiscountCents);
  });
});

describe("referee", () => {
  const greedyShop: Brain = { async decide(c: Ctx): Promise<Decision> { return { accept: c.side === "shop", discountCents: 99999, message: "everything is free", source: "gemini" }; } };
  it("never lets the shop agent exceed the shop's limit", async () => {
    const o = await run(greedyShop);
    expect(o.finalDiscountCents).toBeLessThanOrEqual(capFor(9000, policy));
    expect(o.turns.some((t) => t.note?.includes("limit"))).toBe(true);
  });
  it("never lets the customer agent ask for more than 30% of the bill", async () => {
    const o = await run({ async decide(c) { return { accept: false, discountCents: 99999, message: "x", source: "gemini" }; } });
    expect(o.turns[0].discountCents).toBeLessThanOrEqual(2700);
  });
  it("discount can never push the bill below the minimum total", async () => {
    const o = await run(greedyShop, 120);
    expect(120 - o.finalDiscountCents).toBeGreaterThanOrEqual(100);
  });
  it("ignores a shop that tries to lower its own counter in the final round", async () => {
    let n = 0;
    const flaky: Brain = { async decide(c) { n++; return c.side === "shop" ? { accept: false, discountCents: n < 3 ? 500 : 100, message: "m", source: "gemini" } : { accept: false, discountCents: 800, message: "m", source: "gemini" }; } };
    const o = await run(flaky);
    expect(o.finalDiscountCents).toBeGreaterThanOrEqual(500);
  });
});

describe("GeminiBrain (fetch is stubbed, no network)", () => {
  const ctx: Ctx = { side: "customer", round: 1, merchantName: "Shop", totalCents: 9000, capCents: 900, comfortCents: 450, loyalty: regular, askCents: null, counterCents: null };
  const reply = (obj: unknown) => async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });

  it("sends the key in a header (not the URL) and parses the JSON answer", async () => {
    let seen: any;
    const f = (async (url: string, init: any) => { seen = { url, init }; return reply({ accept: false, discount: 7.5, message: "Could you take $7.50 off?" })(); }) as any;
    const d = await new GeminiBrain("SECRET-KEY", "gemini-2.5-flash", f).decide(ctx);
    expect(d).toMatchObject({ accept: false, discountCents: 750, source: "gemini" });
    expect(seen.url).toContain("gemini-2.5-flash:generateContent");
    expect(seen.url).not.toContain("SECRET-KEY");
    expect(seen.init.headers["x-goog-api-key"]).toBe("SECRET-KEY");
    expect(JSON.parse(seen.init.body).generationConfig.responseMimeType).toBe("application/json");
  });
  it("accepts JSON wrapped in code fences", async () => {
    const f = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '```json\n{"accept":true,"discount":3,"message":"ok"}\n```' }] } }] }), { status: 200 })) as any;
    expect((await new GeminiBrain("k", "m", f).decide(ctx)).discountCents).toBe(300);
  });
  it("falls back to the rule-based agents on bad output, HTTP errors or network failure", async () => {
    const bad = [
      (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }), { status: 200 })) as any,
      (async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })) as any,
      (async () => { throw new Error("offline"); }) as any,
      reply({ accept: "yes", discount: -5, message: "" }) as any,
    ];
    for (const f of bad) {
      const errors: unknown[] = [];
      const d = await new ResilientBrain(new GeminiBrain("k", "m", f), new ScriptedBrain(), (e) => errors.push(e)).decide(ctx);
      expect(d.source).toBe("scripted");
      expect(errors).toHaveLength(1);
    }
  });
  it("makeBrain uses offline agents when there is no key", () => expect(makeBrain({})).toBeInstanceOf(ScriptedBrain));
});

describe("POST /api/haggle", () => {
  const make = (env: Record<string, string> = {}) => buildApp({ NODE_ENV: "test", PAYPAL_MODE: "mock", PUBLIC_URL: "http://t", ...env }, new MockPayPal()).app;
  const haggle = (app: any, body: any) => app.inject({ method: "POST", url: "/api/haggle", payload: body });

  it("returns a transcript and keys that replay to the discounted total", async () => {
    const app = make();
    const j = (await haggle(app, { merchantId: "shop1", keys: K("30+40+20") })).json();
    expect(j.totalBeforeCents).toBe(9000);
    expect(j.turns.length).toBeGreaterThanOrEqual(2);
    expect(j.totalAfterCents).toBe(9000 - j.finalDiscountCents);
    expect(replay(j.keys).totalCents).toBe(j.totalAfterCents);
    expect(j.keys.slice(0, 8).join("")).toBe("30+40+20");
  });
  it("the discounted keys can be paid through the normal payment route", async () => {
    const app = make();
    const j = (await haggle(app, { merchantId: "shop1", keys: K("30+40+20") })).json();
    const p = await app.inject({ method: "POST", url: "/api/pay", payload: { merchantId: "shop1", keys: j.keys } });
    expect(p.statusCode).toBe(200);
    expect(p.json().totalCents).toBe(j.totalAfterCents);
  });
  it("rejects incomplete or tiny bills", async () => {
    const app = make();
    expect((await haggle(app, { merchantId: "shop1", keys: K("30+") })).statusCode).toBe(422);
    expect((await haggle(app, { merchantId: "shop1", keys: K("0.5") })).statusCode).toBe(422);
  });
  it("is rate limited", async () => {
    const app = make({ HAGGLE_MAX_PER_HOUR: "1" });
    expect((await haggle(app, { merchantId: "shop1", keys: K("50") })).statusCode).toBe(200);
    expect((await haggle(app, { merchantId: "shop1", keys: K("50") })).statusCode).toBe(429);
  });
});
//haggle test file is complete and tests negotiation logic, discount keys, cap calculations, and API endpoints for haggle functionality.  