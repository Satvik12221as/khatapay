import { api, button, drawAudit, drawLines, drawVerdict, el, money, REASONS, select, STATE_INFO, text, textarea, type PaymentDTO } from "./common";
import { EventTypes } from "../src/events/sse";
// Simulator functions imported inline to avoid module issues

const list = el<HTMLOListElement>("list");
const msg = el<HTMLElement>("mMsg");
const shopName = el<HTMLElement>("shopName");
const connStatus = el<HTMLElement>("connectionStatus");
const connBadge = el<HTMLElement>("connBadge");
const connMsg = el<HTMLElement>("connMsg");
const simPanel = el<HTMLElement>("simulatorPanel");
const simMsg = el<HTMLElement>("simMsg");
const insightsPanel = el<HTMLElement>("insightsPanel");
const insightsLoading = el<HTMLElement>("insightsLoading");
const insightsContent = el<HTMLElement>("insightsContent");
const invoicesPanel = el<HTMLElement>("invoicesPanel");
const invoicesLoading = el<HTMLElement>("invoicesLoading");
const invoicesContent = el<HTMLElement>("invoicesContent");
const stateFilter = el<HTMLSelectElement>("stateFilter");

let lastJson = "";
let eventSource: EventSource | null = null;
let merchantId = "";

/** Initialize connection status UI */
function setConnectionStatus(state: "connecting" | "connected" | "disconnected", message: string) {
  connStatus.style.display = "flex";
  connBadge.className = "chip";
  connBadge.dataset.kind = state === "connected" ? "ok" : state === "connecting" ? "wait" : "bad";
  connBadge.textContent = state === "connected" ? "Live" : state === "connecting" ? "Connecting..." : "Disconnected";
  connMsg.textContent = message;
}

/** Start SSE connection for real-time events */
function startSSE() {
  if (eventSource) return;
  const url = `/api/events?merchantId=${encodeURIComponent(merchantId)}`;
  eventSource = new EventSource(url);

  eventSource.onopen = () => {
    setConnectionStatus("connected", "Receiving live agent events");
  };

  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleSSEEvent(event);
    } catch {
      // ignore parse errors
    }
  };

  eventSource.onerror = () => {
    setConnectionStatus("disconnected", "Connection lost — will retry");
    eventSource?.close();
    eventSource = null;
    setTimeout(startSSE, 5000);
  };
}

function handleSSEEvent(event: { type: string; [key: string]: unknown }) {
  // Show toast notification
  showToast(event);

  // Refresh relevant panels
  switch (event.type) {
    case EventTypes.AGENT_INSIGHTS_GENERATED:
    case EventTypes.AGENT_INVOICE_GENERATED:
    case EventTypes.AGENT_REFERRAL_PAID:
    case EventTypes.AGENT_HAGGLE_COMPLETED:
    case EventTypes.JUDGE_VERDICT:
    case EventTypes.PAYMENT_STATE_CHANGED:
    case EventTypes.PAYMENT_CAPTURE_COMPLETED:
    case EventTypes.PAYOUT_COMPLETED:
    case EventTypes.REFUND_COMPLETED:
      load(); // Refresh payments
      break;
  }
}

/** Simple toast notification */
function showToast(event: { type: string; [key: string]: unknown }) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 9999;
    background: var(--ink); color: var(--paper); padding: 12px 16px;
    border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    font-size: 13px; max-width: 300px; animation: slideIn 200ms ease-out;
  `;

  const labels: Record<string, string> = {
    [EventTypes.PAYMENT_CAPTURE_COMPLETED]: "💰 Payment captured",
    [EventTypes.PAYOUT_COMPLETED]: "💸 Payout completed",
    [EventTypes.REFUND_COMPLETED]: "↩️ Refund issued",
    [EventTypes.DISPUTE_CREATED]: "⚠️ Dispute opened",
    [EventTypes.AGENT_INSIGHTS_GENERATED]: `🤖 ${event.count} insights generated`,
    [EventTypes.AGENT_INVOICE_GENERATED]: `📄 Invoice ${event.invoiceNumber} generated`,
    [EventTypes.AGENT_REFERRAL_PAID]: `💰 Referral paid: $${event.amountDollars}`,
    [EventTypes.AGENT_HAGGLE_COMPLETED]: `🤝 Haggle: $${event.discountDollars} discount`,
    [EventTypes.JUDGE_VERDICT]: `⚖️ Judges: ${event.outcome === "release" ? "pay shop" : "refund customer"}`,
    [EventTypes.PAYMENT_STATE_CHANGED]: `📦 Payment: ${event.from} → ${event.to}`,
  };

  toast.textContent = labels[event.type] || `Event: ${event.type}`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; toast.style.transition = "opacity 300ms"; setTimeout(() => toast.remove(), 300); }, 4000);
}

/** Load merchant info */
async function init() {
  try {
    const shops = await api<{ id: string; name: string }[]>("/api/merchants");
    const params = new URLSearchParams(location.search);
    merchantId = params.get("shop") || shops[0]?.id || "shop1";
    const shop = shops.find(s => s.id === merchantId);
    shopName.textContent = shop?.name || "Unknown Shop";

    startSSE();
    loadInsights();
    loadInvoices();
    load();

    // Simulator buttons (only in mock mode)
    setupSimulator();
  } catch (e) {
    msg.textContent = (e as Error).message;
  }
}

/** Load AI insights */
async function loadInsights() {
  insightsLoading.style.display = "block";
  insightsContent.style.display = "none";
  try {
    const data = await api<{ insights: any[]; summary: string; source: string }>(`/api/merchants/${merchantId}/insights`);
    insightsLoading.style.display = "none";
    insightsContent.style.display = "block";
    insightsPanel.style.display = "block";
    insightsContent.innerHTML = data.insights.map(i => `
      <div class="shoprow" style="padding: 12px 0; border-top: 1px dashed var(--line);">
        <div style="display:flex; align-items:flex-start; gap:8px;">
          <span class="chip" data-kind="${i.priority === "high" ? "bad" : i.priority === "medium" ? "wait" : "ok"}">${i.priority}</span>
          <div>
            <strong>${i.title}</strong>
            <p class="hint" style="margin:4px 0;">${i.description}</p>
            ${i.actionable && i.recommendedAction ? `<p class="hint" style="margin:4px 0; color:var(--pay);">💡 ${i.recommendedAction}</p>` : ""}
          </div>
        </div>
      </div>
    `).join("");
  } catch (e) {
    insightsLoading.textContent = "Failed to load insights";
  }
}

/** Load generated invoices */
async function loadInvoices() {
  invoicesLoading.style.display = "block";
  invoicesContent.style.display = "none";
  try {
    const payments = await api<PaymentDTO[]>(`/api/payments?merchantId=${merchantId}`);
    const released = payments.filter(p => p.state === "RELEASED" || p.state === "FULFILLED");

    if (released.length === 0) {
      invoicesLoading.textContent = "No completed payments yet. Generate invoices after payments are released.";
      return;
    }

    invoicesLoading.style.display = "none";
    invoicesContent.style.display = "block";
    invoicesPanel.style.display = "block";

    invoicesContent.innerHTML = released.map(p => `
      <div class="shoprow" style="padding: 12px 0; border-top: 1px dashed var(--line);">
        <div style="flex:1;">
          <strong>${money(p.amountCents)} · ${p.merchantName}</strong>
          <p class="hint">${new Date(p.createdAt).toLocaleString()} · ${p.id.slice(0, 8)}</p>
        </div>
        <div style="display:flex; gap:8px; flex-wrap:wrap;">
          <button type="button" class="ghost" onclick="previewInvoice('${p.id}')">Preview</button>
          <button type="button" class="pay" onclick="generateInvoice('${p.id}')">Generate</button>
        </div>
      </div>
    `).join("");
  } catch (e) {
    invoicesLoading.textContent = "Failed to load invoices";
  }
}

/** Generate invoice for a payment */
async function generateInvoice(paymentId: string) {
  const btn = document.querySelector(`button[onclick="generateInvoice('${paymentId}')"]`) as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.textContent = "Generating..."; }
  try {
    const payment = await api<PaymentDTO>(`/api/payments/${paymentId}`);
    const lines = payment.lines.map(l => ({
      description: l.expr,
      quantity: 1,
      unitPriceCents: l.cents,
      totalCents: l.cents,
    }));
    await api("/api/invoices/generate", "POST", {
      paymentId,
      merchant: { id: merchantId, name: payment.merchantName },
      lineItems: lines,
      taxRate: 0.18,
    });
    await loadInvoices();
    showToast({ type: EventTypes.AGENT_INVOICE_GENERATED, invoiceNumber: `INV-${Date.now()}` } as any);
  } catch (e) {
    msg.textContent = (e as Error).message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Generate"; }
  }
}

/** Preview invoice (placeholder) */
function previewInvoice(paymentId: string) {
  window.open(`/api/invoices/preview?paymentId=${paymentId}`, "_blank");
}

/** Simulator setup */
function setupSimulator() {
  simPanel.style.display = "block";

  const handlers: Record<string, { event: string; label: string }> = {
    simCapture: { event: "CAPTURE_COMPLETED", label: "Capture Completed" },
    simPayout: { event: "PAYOUT_COMPLETED", label: "Payout Completed" },
    simRefund: { event: "REFUND_COMPLETED", label: "Refund Completed" },
    simDispute: { event: "DISPUTE_CREATED", label: "Dispute Created" },
  };

  for (const [id, { event, label }] of Object.entries(handlers)) {
    const btn = el<HTMLButtonElement>(id);
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = `Simulating ${label}...`;
      simMsg.textContent = `Simulating ${label}...`;
      try {
        await api("/webhooks/simulate", "POST", { event });
        simMsg.textContent = `${label} simulated successfully!`;
        showToast({ type: event } as any);
      } catch (e) {
        simMsg.textContent = (e as Error).message;
      } finally {
        btn.disabled = false; btn.textContent = label;
      }
    });
  }

  // Insights/Invoice simulator buttons
  el<HTMLButtonElement>("simInsights").addEventListener("click", async () => {
    const btn = el<HTMLButtonElement>("simInsights");
    btn.disabled = true; btn.textContent = "Generating...";
    try {
      await api("/api/merchants/" + merchantId + "/insights", "GET");
      showToast({ type: EventTypes.AGENT_INSIGHTS_GENERATED, count: 3 } as any);
      loadInsights();
    } catch (e) { simMsg.textContent = (e as Error).message; }
    finally { btn.disabled = false; btn.textContent = "Generate Insights"; }
  });

  el<HTMLButtonElement>("simInvoice").addEventListener("click", async () => {
    const btn = el<HTMLButtonElement>("simInvoice");
    btn.disabled = true; btn.textContent = "Generating...";
    try {
      const payments = await api<PaymentDTO[]>(`/api/payments?merchantId=${merchantId}`);
      const released = payments.find(p => p.state === "RELEASED");
      if (!released) throw new Error("No released payments to invoice");
      const lines = released.lines.map(l => ({ description: l.expr, quantity: 1, unitPriceCents: l.cents, totalCents: l.cents }));
      await api("/api/invoices/generate", "POST", { paymentId: released.id, merchant: { id: merchantId, name: released.merchantName }, lineItems: lines, taxRate: 0.18 });
      showToast({ type: EventTypes.AGENT_INVOICE_GENERATED, invoiceNumber: `INV-${Date.now()}` } as any);
      loadInvoices();
    } catch (e) { simMsg.textContent = (e as Error).message; }
    finally { btn.disabled = false; btn.textContent = "Generate Invoice"; }
  });
}

/** Payment card rendering (enhanced from merchant.ts) */
function card(p: PaymentDTO): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "card";
  const info = STATE_INFO[p.state];
  const head = document.createElement("div");
  head.className = "card-head";
  const badge = text("span", "badge", info.label);
  badge.dataset.kind = info.kind;
  head.append(text("strong", "", `${money(p.amountCents)} · ${p.merchantName}`), badge);
  li.append(head, text("div", "ref", `${new Date(p.createdAt).toLocaleString()} · ${p.id.slice(0, 8)}`));

  const lines = document.createElement("ol");
  lines.className = "lines";
  drawLines(lines, p.lines);
  li.append(lines);

  const act = (path: string, body?: unknown) => async () => {
    msg.textContent = "";
    try { await api(`/api/payments/${encodeURIComponent(p.id)}/${path}`, "POST", body); } catch (e) { msg.textContent = (e as Error).message; }
    lastJson = ""; await load();
  };

  if (p.state === "HELD") li.append(button("Mark delivered", "pay", act("deliver")));
  if (p.state === "FULFILLED") li.append(text("p", "hint", "Waiting for the customer to confirm."));
  if (p.state === "DISPUTED" && p.dispute) {
    const d = p.dispute;
    li.append(text("p", "hint", `Customer claim: ${REASONS[d.reason] ?? d.reason}${d.note ? ` ("${d.note}")` : ""}`));
    if (!d.shopStance) {
      const stance = select({ delivered_ok: "I delivered, the claim is wrong", agrees_refund: "I agree to refund" });
      const note = textarea("Your side (optional)");
      li.append(stance, note, button("Send reply", "ghost", async () => act("respond", { stance: stance.value, note: note.value })()));
    } else {
      li.append(text("p", "hint", `Your reply: ${d.shopStance === "agrees_refund" ? "agree to refund" : "delivered"}${d.shopNote ? ` ("${d.shopNote}")` : ""}`));
    }
    if (!d.verdict) li.append(button("Ask the Tape Judges", "pay", act("judge")));
  }
  const verdict = document.createElement("div");
  verdict.className = "verdict";
  drawVerdict(verdict, p.dispute?.verdict);
  li.append(verdict);

  const facts = document.createElement("dl");
  facts.className = "facts";
  for (const [k, v] of [["Captured", p.captureId], ["Payout", p.payoutId], ["Refund", p.refundId]] as const) if (v) facts.append(text("dt", "", k), text("dd", "", v));
  li.append(facts);

  const det = document.createElement("details");
  det.className = "audit";
  det.append(text("summary", "", "Audit trail"));
  const ol = document.createElement("ol");
  drawAudit(ol, p.events);
  det.append(ol);
  li.append(det);
  return li;
}

async function load() {
  try {
    const all = await api<PaymentDTO[]>(`/api/payments`);
    const filter = stateFilter.value;
    const shown = all.filter(p => {
      if (filter && p.state !== filter) return false;
      return p.state !== "CREATED" && p.state !== "CANCELLED";
    });
    const json = JSON.stringify(shown);
    if (json === lastJson) return;
    if (list.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement) return;
    lastJson = json;
    list.replaceChildren(...shown.map(card));
    if (!shown.length) list.append(text("li", "hint", "No payments yet. Make one on the customer keypad."));
  } catch (e) {
    msg.textContent = (e as Error).message;
  }
}

// Expose functions for inline onclick
(window as any).generateInvoice = generateInvoice;
(window as any).previewInvoice = previewInvoice;

stateFilter.addEventListener("change", () => { lastJson = ""; load(); });
void init();
setInterval(load, 3000);