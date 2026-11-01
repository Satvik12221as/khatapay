import { api, button, el, money, text } from "./common";

/** What main.ts lets this file do. Keeps all keypad logic in main.ts. */
export interface Ctx {
  press(key: string): void;
  total(): number | null;
  shop(): { id: string; name: string };
  setShop(id: string): void;
  sleep(ms: number): Promise<void>;
}

interface TrustDTO { merchantId: string; score: number; tier: string; explanation: string }
interface Landing {
  valid: boolean; reason?: string; referrerName?: string; merchantId?: string; merchantName?: string;
  trust?: { score: number; tier: string; explanation: string }; welcomeCents?: number; minOrderCents?: number; message?: string;
}
interface Dash {
  customer: { id: string; name: string; paypalEmail?: string; referralCode: string };
  shops: { merchantId: string; name: string; orders: number; trustScore: number; tier: string; eligible: boolean; reason?: string }[];
  referrals: { id: string; role: "referrer" | "referee"; merchantName: string; state: "PENDING" | "REWARDED" | "VOID"; welcomeCents: number; rewardCents?: number; reason?: string }[];
  earnedCents: number;
  terms: { minOrdersToRefer: number; minTrust: number; minOrderCents: number; welcomeCents: number; rewardCents: number; maxRewardsPer30d: number };
}
interface Draft {
  merchantName: string; message: string; source: "gemini" | "scripted"; code: string; path: string;
  trust: { score: number; tier: string; explanation: string }; welcomeCents: number; rewardCents: number; minOrderCents: number;
}

const KEY = "khatapay.customer";
const REF = "khatapay.ref";
let customerId = "";
let trusts: TrustDTO[] = [];
let ctx: Ctx;
let landing: Landing | null = null;

const store = {
  get: (s: Storage, k: string) => { try { return s.getItem(k) ?? ""; } catch { return ""; } },
  set: (s: Storage, k: string, v: string) => { try { s.setItem(k, v); } catch { /* private mode */ } },
  del: (s: Storage, k: string) => { try { s.removeItem(k); } catch { /* private mode */ } },
};

/** The discount as key presses, e.g. 200 -> "-", "2". Same rule as the server. */
const discountKeys = (cents: number) => ["-", ...(cents / 100).toFixed(2).replace(/\.?0+$/, "").split("")];

// ---------- identity ----------
async function ensureCustomer(): Promise<void> {
  customerId = store.get(localStorage, KEY);
  if (customerId) {
    try { await api(`/api/customers/${customerId}`); return; } catch { customerId = ""; }
  }
  const c = await api<{ id: string }>("/api/customers", "POST", { name: "Guest" });
  customerId = c.id;
  store.set(localStorage, KEY, customerId);
}

// ---------- trust badge ----------
function showTrust() {
  const badge = el<HTMLButtonElement>("trustBadge");
  const why = el<HTMLElement>("trustWhy");
  const t = trusts.find((x) => x.merchantId === ctx.shop().id);
  why.hidden = true;
  badge.hidden = !t;
  if (!t) return;
  badge.textContent = `Trust ${t.score} · ${t.tier}`;
  badge.dataset.tier = t.tier;
  why.textContent = t.explanation;
}

// ---------- the friend's side: landing banner + welcome discount ----------
async function showLanding() {
  const q = new URLSearchParams(location.search);
  const code = q.get("ref");
  const shop = q.get("shop");
  if (!code || !shop) return;
  store.set(sessionStorage, REF, code);
  const banner = el<HTMLElement>("refBanner");
  banner.hidden = false;
  try {
    landing = await api<Landing>(`/api/referrals/landing?code=${encodeURIComponent(code)}&shop=${encodeURIComponent(shop)}`);
  } catch (e) {
    banner.replaceChildren(text("p", "hint", (e as Error).message));
    store.del(sessionStorage, REF);
    return;
  }
  banner.replaceChildren();
  if (!landing.valid) {
    banner.append(text("p", "hint", landing.reason ?? "This referral is not available."));
    store.del(sessionStorage, REF);
    return;
  }
  const l = landing;
  ctx.setShop(l.merchantId!);
  const note = text("p", "hint", "");
  const apply = button(`Apply welcome -${money(l.welcomeCents!)}`, "ghost", async () => {
    const total = ctx.total();
    if (total === null || total - l.welcomeCents! < l.minOrderCents!) {
      note.textContent = `Add your items first. After the discount your order must be at least ${money(l.minOrderCents!)}.`;
      return;
    }
    for (const k of discountKeys(l.welcomeCents!)) { ctx.press(k); await ctx.sleep(180); }
    note.textContent = "Welcome discount added to your bill.";
    apply.hidden = true;
  });
  banner.append(
    text("strong", "", `${l.referrerName} recommends ${l.merchantName}`),
    text("p", "", l.message ?? ""),
    text("p", "hint", `Trust ${l.trust!.score} (${l.trust!.tier}): ${l.trust!.explanation}`),
    text("p", "hint", `Welcome discount ${money(l.welcomeCents!)} on your first order of ${money(l.minOrderCents!)} or more.`),
    apply, note,
  );
}

/** Called by main.ts right after a payment is created. Best effort: a payment never fails because of this. */
export async function linkPayment(paymentId: string): Promise<void> {
  if (!customerId) return;
  const code = store.get(sessionStorage, REF);
  try {
    const r = await api<{ referral?: unknown; referralRejected?: string }>(`/api/customers/${customerId}/link`, "POST", { paymentId, ...(code ? { referralCode: code } : {}) });
    if (code && (r.referral || r.referralRejected)) store.del(sessionStorage, REF);
  } catch { /* ignore */ }
}

// ---------- the referrer's side: "Refer a friend" ----------
const field = (placeholder: string, value = "", type = "text") => {
  const i = document.createElement("input");
  i.className = "field"; i.placeholder = placeholder; i.value = value; i.type = type; i.maxLength = 120;
  return i;
};
const STATE_LABEL = { PENDING: "In progress", REWARDED: "Paid", VOID: "Not paid" } as const;

async function copy(value: string, note: HTMLElement) {
  try { await navigator.clipboard.writeText(value); note.textContent = "Copied."; } catch { note.textContent = "Select the text and copy it."; }
}

function showDraft(host: HTMLElement, d: Draft) {
  host.replaceChildren();
  const note = text("p", "hint", "");
  const url = location.origin + d.path;
  const msg = document.createElement("textarea");
  msg.readOnly = true; msg.rows = 4; msg.value = d.message;
  const link = field("", url);
  link.readOnly = true;
  host.append(
    text("h3", "", `Recommend ${d.merchantName}`),
    text("p", "hint", `Written by the ${d.source === "gemini" ? "Gemini" : "offline"} referral agent. Every number was fact-checked against real payment data.`),
    msg, button("Copy message", "ghost", () => copy(d.message, note)),
    link, button("Copy link", "ghost", () => copy(url, note)), note,
    text("p", "hint", `Trust ${d.trust.score} (${d.trust.tier}): ${d.trust.explanation}`),
    text("p", "hint", `Your friend gets ${money(d.welcomeCents)} off a first order of ${money(d.minOrderCents)}+. You get ${money(d.rewardCents)} when it completes with no dispute.`),
  );
}

async function renderRefer() {
  const body = el<HTMLElement>("referBody");
  body.replaceChildren(text("p", "hint", "Loading..."));
  let d: Dash;
  try { d = await api<Dash>(`/api/customers/${customerId}`); } catch (e) { body.replaceChildren(text("p", "warn", (e as Error).message)); return; }
  body.replaceChildren();
  const t = d.terms;

  const name = field("Your name", d.customer.name);
  const email = field("PayPal email, so we can pay your rewards", d.customer.paypalEmail ?? "", "email");
  const saveMsg = text("p", "warn", "");
  saveMsg.hidden = true;
  body.append(text("h3", "", "You"), name, email, button("Save", "ghost", async () => {
    try {
      await api(`/api/customers/${customerId}/profile`, "POST", { name: name.value.trim() || undefined, ...(email.value.trim() ? { paypalEmail: email.value.trim() } : {}) });
      await renderRefer();
    } catch (e) { saveMsg.textContent = (e as Error).message; saveMsg.hidden = false; }
  }), saveMsg);

  body.append(text("h3", "", "Your shops"));
  for (const s of d.shops) {
    const row = document.createElement("div");
    row.className = "shoprow";
    const chip = text("span", s.eligible ? "chip ok" : "chip", s.eligible ? "Unlocked" : "Locked");
    row.append(text("strong", "", s.name), text("span", "hint", `${s.orders} of ${t.minOrdersToRefer} orders · trust ${s.trustScore}`), chip);
    if (!s.eligible && s.reason) row.append(text("p", "hint", s.reason));
    body.append(row);
  }

  const draftHost = document.createElement("div");
  draftHost.className = "draft";
  if (d.shops.some((s) => s.eligible)) {
    const needs = field("Who is it for? (optional, e.g. a friend who likes organic vegetables)");
    needs.maxLength = 200;
    const err = text("p", "warn", "");
    err.hidden = true;
    body.append(text("h3", "", "Refer a friend"), needs, button("Write my referral with AI", "pay", async () => {
      err.hidden = true;
      draftHost.replaceChildren(text("p", "hint", "The referral agent is choosing a shop and checking its facts..."));
      try {
        showDraft(draftHost, await api<Draft>(`/api/customers/${customerId}/refer`, "POST", { needs: needs.value }));
      } catch (e) { draftHost.replaceChildren(); err.textContent = (e as Error).message; err.hidden = false; }
    }), err, draftHost);
  }
  body.append(text("p", "hint", `Your friend gets ${money(t.welcomeCents)} off. You get ${money(t.rewardCents)} for each friend whose first order of ${money(t.minOrderCents)}+ completes with no dispute (max ${t.maxRewardsPer30d} a month).`));

  body.append(text("h3", "", `My referrals${d.earnedCents ? ` · earned ${money(d.earnedCents)}` : ""}`));
  if (!d.referrals.length) body.append(text("p", "hint", "None yet."));
  for (const r of d.referrals) {
    const row = document.createElement("div");
    row.className = "shoprow";
    const who = r.role === "referrer" ? `Friend at ${r.merchantName}` : `Your welcome discount at ${r.merchantName}`;
    const amount = r.state === "REWARDED" && r.rewardCents ? ` · ${money(r.rewardCents)}` : "";
    row.append(text("strong", "", who), text("span", "chip", STATE_LABEL[r.state] + amount));
    if (r.reason) row.append(text("p", "hint", r.reason));
    body.append(row);
  }
}

// ---------- start ----------
export async function initCustomer(c: Ctx): Promise<{ onShopChanged(): void }> {
  ctx = c;
  const none = { onShopChanged() { /* server unreachable */ } };
  try {
    await ensureCustomer();
    trusts = await api<TrustDTO[]>("/api/trust");
  } catch { return none; }
  const sheet = el<HTMLDialogElement>("referSheet");
  el<HTMLButtonElement>("trustBadge").addEventListener("click", () => { const w = el<HTMLElement>("trustWhy"); w.hidden = !w.hidden; });
  el<HTMLButtonElement>("referBtn").addEventListener("click", () => { sheet.showModal(); void renderRefer(); });
  el<HTMLButtonElement>("referClose").addEventListener("click", () => sheet.close());
  showTrust();
  await showLanding();
  showTrust();
  return { onShopChanged: showTrust };
}