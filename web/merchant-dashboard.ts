import { api, button, drawAudit, drawLines, drawVerdict, el, money, REASONS, select, STATE_INFO, text, textarea, type PaymentDTO } from "./common";
import { EventTypes } from "../src/events/sse";
import { createGrid, GridOptions, ColDef, GridReadyEvent, RowDoubleClickedEvent } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";

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
const gridContainer = el<HTMLDivElement>("paymentsGrid");
const searchInput = el<HTMLInputElement>("paymentSearch");
const refreshBtn = el<HTMLButtonElement>("refreshBtn");

let merchantId = "";
let gridApi: any = null;
let lastJson = "";
let eventSource: EventSource | null = null;

// ---- Cell Renderers ----
const cellRendererState = (params: { value: string }) => {
  const info = STATE_INFO[params.value as keyof typeof STATE_INFO];
  if (!info) return params.value;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.kind = info.kind;
  badge.textContent = info.label;
  return badge;
};

const cellRendererDispute = (params: { value: { reason: string } | undefined }) => {
  if (!params.value) return "—";
  const d = params.value;
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.kind = "bad";
  badge.textContent = REASONS[d.reason] ?? d.reason;
  return badge;
};

const cellRendererActions = (params: { value: string }) => {
  const container = document.createElement("div");
  container.style.display = "flex";
  container.style.gap = "4px";
  container.style.flexWrap = "wrap";
  container.style.justifyContent = "center";
  return container;
};

// ---- Column Definitions ----
const columnDefs: any[] = [
  {
    headerName: "State",
    field: "state",
    width: 130,
    cellRenderer: cellRendererState,
    pinned: "left",
    filter: "agSetColumnFilter",
    filterParams: {
      values: ["HELD", "FULFILLED", "DISPUTED", "RELEASED", "REFUNDED", "FAILED", "CANCELLED"],
    },
  },
  {
    headerName: "Amount",
    field: "amountCents",
    width: 110,
    valueFormatter: (params: { value: number }) => money(params.value),
    pinned: "left",
    filter: "agNumberColumnFilter",
  },
  {
    headerName: "Merchant",
    field: "merchantName",
    width: 180,
    filter: "agTextColumnFilter",
  },
  {
    headerName: "Created",
    field: "createdAt",
    width: 160,
    valueFormatter: (params: { value: string }) => new Date(params.value).toLocaleString(),
    filter: "agDateColumnFilter",
  },
  {
    headerName: "Items",
    field: "lines",
    width: 100,
    valueFormatter: (params: { value: any[] }) => `${params.value?.length ?? 0} items`,
  },
  {
    headerName: "Dispute",
    field: "dispute",
    width: 100,
    cellRenderer: (params: { value: { reason: string } | undefined }) => {
      if (!params.value) return "—";
      const d = params.value;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.dataset.kind = "bad";
      badge.textContent = REASONS[d.reason] ?? d.reason;
      return badge;
    },
    filter: "agTextColumnFilter",
  },
  {
    headerName: "Actions",
    field: "id",
    width: 200,
    cellRenderer: (params: { value: string }) => {
      const container = document.createElement("div");
      container.style.display = "flex";
      container.style.gap = "4px";
      container.style.flexWrap = "wrap";
      container.style.justifyContent = "center";
      return container;
    },
    suppressSizeToFit: true,
  },
];

const defaultColDef: any = {
  sortable: true,
  filter: true,
  resizable: true,
  suppressSizeToFit: true,
};

// ---- Init ----
function initGrid() {
  const gridOptions: any = {
    columnDefs,
    defaultColDef,
    rowData: [],
    rowHeight: 52,
    animateRows: true,
    pagination: true,
    paginationPageSize: 20,
    paginationPageSizeSelector: [10, 20, 50, 100],
    rowSelection: "single",
    suppressRowClickSelection: true,
    onRowDoubleClicked: onRowDoubleClicked,
    onGridReady: (event: any) => {
      gridApi = event.api;
      load();
    },
    getRowId: (params: any) => params.data.id,
    suppressRowHoverHighlight: false,
    localeText: {
      noRowsToShow: "No payments yet. Make one on the customer keypad.",
    },
  };

  gridApi = createGrid(gridContainer, gridOptions);
}

// ---- Connection Status ----
function setConnectionStatus(state: "connecting" | "connected" | "disconnected", message: string) {
  connStatus.style.display = "flex";
  connBadge.className = "chip";
  connBadge.dataset.kind = state === "connected" ? "ok" : state === "connecting" ? "wait" : "bad";
  connBadge.textContent = state === "connected" ? "Live" : state === "connecting" ? "Connecting..." : "Disconnected";
  connMsg.textContent = message;
}

function startSSE() {
  if (eventSource) return;
  const url = `/api/events?merchantId=${encodeURIComponent(merchantId)}`;
  eventSource = new EventSource(url);

  eventSource.onopen = () => setConnectionStatus("connected", "Receiving live agent events");

  eventSource.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data);
      handleSSEEvent(event);
    } catch { /* ignore */ }
  };

  eventSource.onerror = () => {
    setConnectionStatus("disconnected", "Connection lost — will retry");
    eventSource?.close();
    eventSource = null;
    setTimeout(startSSE, 5000);
  };
}

function handleSSEEvent(event: { type: string; [key: string]: unknown }) {
  showToast(event);
  if ([
    EventTypes.AGENT_INSIGHTS_GENERATED,
    EventTypes.AGENT_INVOICE_GENERATED,
    EventTypes.AGENT_REFERRAL_PAID,
    EventTypes.AGENT_HAGGLE_COMPLETED,
    EventTypes.JUDGE_VERDICT,
    EventTypes.PAYMENT_STATE_CHANGED,
    EventTypes.PAYMENT_CAPTURE_COMPLETED,
    EventTypes.PAYOUT_COMPLETED,
    EventTypes.REFUND_COMPLETED,
  ].includes(event.type)) {
    load();
  }
}

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

  toast.textContent = labels[event.type] ?? `Event: ${event.type}`;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; toast.style.transition = "opacity 300ms"; setTimeout(() => toast.remove(), 300); }, 4000);
}

// ---- Load Data ----
async function load() {
  try {
    const all = await api<PaymentDTO[]>("/api/payments");
    const filter = stateFilter.value;
    const shown = all.filter(p => {
      if (filter && p.state !== filter) return false;
      return p.state !== "CREATED" && p.state !== "CANCELLED";
    });

    if (gridApi) {
      gridApi.setGridOption("rowData", shown);
    }
    lastJson = JSON.stringify(shown);
  } catch (e) {
    msg.textContent = (e as Error).message;
  }
}

// ---- Event Handlers ----
function onRowDoubleClicked(event: any) {
  const p = event.data;
  if (!p) return;
  showPaymentDetail(p);
}

function showPaymentDetail(p: PaymentDTO) {
  const info = STATE_INFO[p.state];
  const modal = document.createElement("dialog");
  modal.className = "sheet";
  modal.style.maxWidth = "600px";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.kind = info.kind;
  badge.textContent = info.label;

  const lines = document.createElement("ol");
  lines.className = "lines";
  p.lines.forEach(l => {
    const li = document.createElement("li");
    li.style.display = "flex";
    li.style.justifyContent = "space-between";
    li.append(document.createTextNode(l.expr), document.createTextNode(money(l.cents)));
    lines.append(li);
  });

  const actionsDiv = document.createElement("div");
  actionsDiv.style.display = "flex";
  actionsDiv.style.flexDirection = "column";
  actionsDiv.style.gap = "8px";
  actionsDiv.style.marginTop = "16px";

  const makeAction = (label: string, path: string, body?: unknown, cls = "pay") => {
    const btn = button(label, cls, async () => {
      try { await api(`/api/payments/${encodeURIComponent(p.id)}/${path}`, "POST", body); } catch (e) { msg.textContent = (e as Error).message; }
      load();
      modal.close();
    });
    return btn;
  };

  if (p.state === "HELD") actionsDiv.append(makeAction("Mark delivered", "deliver"));
  if (p.state === "FULFILLED") actionsDiv.append(document.createTextNode("Waiting for the customer to confirm."));
  if (p.state === "DISPUTED" && p.dispute) {
    const d = p.dispute;
    if (!d.shopStance) {
      const stance = select({ delivered_ok: "I delivered, the claim is wrong", agrees_refund: "I agree to refund" });
      const note = textarea("Your side (optional)");
      actionsDiv.append(stance, note, makeAction("Send reply", "respond", { stance: stance.value, note: note.value }, "ghost"));
    } else {
      actionsDiv.append(document.createTextNode(`Your reply: ${d.shopStance === "agrees_refund" ? "agree to refund" : "delivered"}${d.shopNote ? ` ("${d.shopNote}")` : ""}`));
    }
    if (!d.verdict) actionsDiv.append(makeAction("Ask the Tape Judges", "judge"));
  }

  const verdict = document.createElement("div");
  verdict.className = "verdict";

  const facts = document.createElement("dl");
  facts.className = "facts";
  for (const [k, v] of [["Captured", p.captureId], ["Payout", p.payoutId], ["Refund", p.refundId]] as const) if (v) facts.append(text("dt", "", k), text("dd", "", v));

  const det = document.createElement("details");
  det.className = "audit";
  det.append(text("summary", "", "Audit trail"));
  const ol = document.createElement("ol");

  modal.append(
    document.createElement("h2").append(document.createTextNode(`${money(p.amountCents)} · ${p.merchantName}`), badge),
    document.createElement("div").append(document.createTextNode(`${new Date(p.createdAt).toLocaleString()} · ${p.id.slice(0, 8)}`)),
    lines,
    document.createElement("hr"),
    actionsDiv,
    verdict,
    facts,
    det,
    button("Close", "ghost", () => modal.close())
  );

  document.body.appendChild(modal);
  modal.showModal();
}

// ---- Simulator ----
function setupSimulator() {
  simPanel.style.display = "block";
  const handlers: Record<string, { event?: string; label: string }> = {
    simCapture: { event: "CAPTURE_COMPLETED", label: "Capture Completed" },
    simPayout: { event: "PAYOUT_COMPLETED", label: "Payout Completed" },
    simRefund: { event: "REFUND_COMPLETED", label: "Refund Completed" },
    simDispute: { event: "DISPUTE_CREATED", label: "Dispute Created" },
    simInsights: { label: "Generate Insights" },
    simInvoice: { label: "Generate Invoice" },
  };

  for (const [id, handler] of Object.entries(handlers)) {
    const btn = el<HTMLButtonElement>(id);
    btn.addEventListener("click", async () => {
      btn.disabled = true; btn.textContent = `Simulating ${handler.label}...`;
      simMsg.textContent = `Simulating ${handler.label}...`;
      try {
        if (handler.event) {
          await api("/webhooks/simulate", "POST", { event: handler.event });
          showToast({ type: handler.event } as any);
        } else if (id === "simInsights") {
          await api(`/api/merchants/${merchantId}/insights`, "GET");
          loadInsights();
        } else if (id === "simInvoice") {
          const payments = await api<PaymentDTO[]>(`/api/payments?merchantId=${merchantId}`);
          const released = payments.find(p => p.state === "RELEASED");
          if (!released) throw new Error("No released payments to invoice");
          const lines = released.lines.map(l => ({ description: l.expr, quantity: 1, unitPriceCents: l.cents, totalCents: l.cents }));
          await api("/api/invoices/generate", "POST", { paymentId: released.id, merchant: { id: merchantId, name: released.merchantName }, lineItems: lines, taxRate: 0.18 });
          showToast({ type: "AGENT_INVOICE_GENERATED", invoiceNumber: `INV-${Date.now()}` } as any);
          loadInvoices();
        }
        simMsg.textContent = `${handler.label} simulated successfully!`;
      } catch (e) {
        simMsg.textContent = (e as Error).message;
      } finally {
        btn.disabled = false; btn.textContent = handler.label;
      }
    });
  }
}

// ---- Insights / Invoices ----
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

async function generateInvoice(paymentId: string) {
  const btn = document.querySelector(`button[onclick="generateInvoice('${paymentId}')"]`) as HTMLButtonElement;
  if (btn) { btn.disabled = true; btn.textContent = "Generating..."; }
  try {
    const payment = await api<PaymentDTO>(`/api/payments/${paymentId}`);
    const lines = payment.lines.map(l => ({ description: l.expr, quantity: 1, unitPriceCents: l.cents, totalCents: l.cents }));
    await api("/api/invoices/generate", "POST", {
      paymentId,
      merchant: { id: merchantId, name: payment.merchantName },
      lineItems: lines,
      taxRate: 0.18,
    });
    await loadInvoices();
    showToast({ type: "AGENT_INVOICE_GENERATED", invoiceNumber: `INV-${Date.now()}` } as any);
  } catch (e) {
    msg.textContent = (e as Error).message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Generate"; }
  }
}

function previewInvoice(paymentId: string) {
  window.open(`/api/invoices/preview?paymentId=${paymentId}`, "_blank");
}

// ---- Search ----
searchInput.addEventListener("input", (e) => {
  if (gridApi) {
    gridApi.setGridOption("quickFilterText", (e.target as HTMLInputElement).value);
  }
});

refreshBtn.addEventListener("click", () => { lastJson = ""; load(); });

// ---- Init ----
async function init() {
  try {
    const shops = await api<{ id: string; name: string }[]>("/api/merchants");
    const params = new URLSearchParams(location.search);
    merchantId = params.get("shop") || shops[0]?.id || "shop1";
    const shop = shops.find(s => s.id === merchantId);
    shopName.textContent = shop?.name || "Unknown Shop";

    initGrid();
    startSSE();
    loadInsights();
    loadInvoices();
    setupSimulator();
  } catch (e) {
    msg.textContent = (e as Error).message;
  }
}

// Global exports for inline handlers
(window as any).generateInvoice = generateInvoice;
(window as any).previewInvoice = previewInvoice;

stateFilter.addEventListener("change", () => load());
void init();
setInterval(load, 3000);