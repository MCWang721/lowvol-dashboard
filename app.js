"use strict";

const TRADES_KEY = "lowvol-v51-trades";
const CAPITAL_KEY = "lowvol-v51-capital";
const state = {
  statuses: [],
  trades: loadJson(TRADES_KEY, []),
  initialCapital: Number(localStorage.getItem(CAPITAL_KEY)) || 1_000_000,
};

const byId = (id) => document.getElementById(id);
const money = (value) => new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0,
}).format(value);
const pct = (value) => `${(value * 100).toFixed(2)}%`;
const actionLabel = (action) => action === "BUY" ? "买入" : action === "SELL" ? "卖出" : "持有";

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}

function showNotice(message) {
  const notice = byId("notice");
  notice.textContent = message;
  notice.hidden = false;
}

function account(latest) {
  const cash = state.trades.reduce(
    (sum, trade) => sum + (trade.side === "BUY" ? -trade.amount : trade.amount),
    state.initialCapital,
  );
  const shares = state.trades.reduce(
    (sum, trade) => sum + (trade.side === "BUY" ? trade.shares : -trade.shares),
    0,
  );
  const positionValue = shares * latest.close;
  const equity = cash + positionValue;
  return {
    shares,
    equity,
    gap: equity * latest.targetExposure - positionValue,
  };
}

function render() {
  const latest = state.statuses[0];
  if (!latest) return;
  const summary = account(latest);

  byId("trade-date").textContent = latest.tradeDate;
  byId("action").textContent = actionLabel(latest.action);
  byId("target").textContent = `${Math.round(latest.targetExposure * 100)}%`;
  byId("signal-reason").textContent = latest.signalReason;
  byId("close").textContent = `¥${latest.close.toFixed(3)}`;
  byId("drawdown").textContent = pct(latest.drawdown);
  byId("equity").textContent = money(summary.equity);
  byId("shares").textContent = `${summary.shares.toLocaleString()} 份`;

  const card = byId("signal-card");
  card.className = `signal-card ${latest.action === "BUY" ? "buy" : latest.action === "SELL" ? "sell" : "hold"}`;
  const signalState = byId("signal-state");
  signalState.className = latest.targetChanged ? "urgent-row" : "quiet-row";
  signalState.textContent = latest.targetChanged
    ? "下一交易日需要调仓，9:30 后核对价格再操作"
    : "下一交易日无需调仓，继续持有";

  byId("suggestion-title").textContent =
    summary.gap > 0 ? "建议补买" : summary.gap < 0 ? "建议卖出" : "仓位已对齐";
  byId("suggestion-amount").textContent = money(Math.abs(summary.gap));
  byId("suggestion-amount").className = summary.gap >= 0 ? "positive" : "negative";

  const price = byId("trade-price");
  const date = byId("executed-at");
  price.value = price.defaultValue = latest.close.toFixed(3);
  date.value = date.defaultValue = latest.tradeDate;
  byId("initial-capital").value = state.initialCapital;
  renderHistory();
  renderTrades();
}

function renderHistory() {
  const timeline = byId("timeline");
  timeline.replaceChildren();
  for (const status of state.statuses.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "timeline-row";
    const mark = document.createElement("span");
    mark.className = `timeline-mark ${status.targetChanged ? "changed" : ""}`;
    const copy = document.createElement("div");
    const date = document.createElement("strong");
    date.textContent = status.tradeDate;
    const detail = document.createElement("p");
    detail.textContent = `${actionLabel(status.action)} · 目标 ${Math.round(status.targetExposure * 100)}%`;
    copy.append(date, detail);
    const drawdown = document.createElement("span");
    drawdown.textContent = pct(status.drawdown);
    row.append(mark, copy, drawdown);
    timeline.append(row);
  }
}

function renderTrades() {
  const list = byId("trade-list");
  list.replaceChildren();
  byId("trade-list-wrap").hidden = state.trades.length === 0;
  for (const trade of state.trades.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "trade-row";
    const side = document.createElement("span");
    side.className = `trade-side ${trade.side.toLowerCase()}`;
    side.textContent = actionLabel(trade.side);
    const copy = document.createElement("div");
    const amount = document.createElement("strong");
    amount.textContent = money(trade.amount);
    const detail = document.createElement("small");
    detail.textContent = `${trade.executedAt} · ${trade.shares.toLocaleString()} 份`;
    copy.append(amount, detail);
    const price = document.createElement("span");
    price.textContent = `¥${trade.price.toFixed(3)}`;
    row.append(side, copy, price);
    list.append(row);
  }
}

function switchTab(tab) {
  for (const name of ["today", "record", "settings"]) {
    byId(`${name}-panel`).hidden = name !== tab;
  }
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.classList.toggle("active", button.dataset.tab === tab);
  }
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]")?.dataset.tab;
  if (tab) switchTab(tab);
  if (event.target.id === "notice") event.target.hidden = true;
});

byId("trade-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const latest = state.statuses[0];
  if (!latest) return;
  const form = new FormData(event.currentTarget);
  const side = form.get("side") === "SELL" ? "SELL" : "BUY";
  const amount = Number(form.get("amount"));
  const price = Number(form.get("price"));
  const executedAt = String(form.get("executedAt") || "");
  const shares = Math.floor(amount / price / 100) * 100;
  const currentShares = account(latest).shares;
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price <= 0 || shares < 100) {
    showNotice("请填写有效的成交金额和价格");
    return;
  }
  if (side === "SELL" && shares > currentShares) {
    showNotice(`卖出份额超过已登记持仓（当前 ${currentShares.toLocaleString()} 份）`);
    return;
  }
  state.trades.unshift({
    id: Date.now(),
    side,
    amount,
    price,
    shares,
    executedAt,
    note: String(form.get("note") || "").slice(0, 120),
  });
  localStorage.setItem(TRADES_KEY, JSON.stringify(state.trades));
  event.currentTarget.reset();
  showNotice(`已登记${actionLabel(side)} ${money(amount)}`);
  switchTab("today");
  render();
});

byId("capital-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const value = Number(new FormData(event.currentTarget).get("initialCapital"));
  if (!Number.isFinite(value) || value <= 0) {
    showNotice("请输入有效的初始资金");
    return;
  }
  state.initialCapital = value;
  localStorage.setItem(CAPITAL_KEY, String(value));
  showNotice("初始资金已保存在本机");
  switchTab("today");
  render();
});

fetch(`./status.json?v=${Date.now()}`, { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((payload) => {
    state.statuses = Array.isArray(payload.statuses) ? payload.statuses : [];
    render();
  })
  .catch(() => showNotice("每日数据暂时无法读取，请稍后刷新"));
