"use strict";

const TRADES_KEY = "lowvol-v51-trades";
const CAPITAL_KEY = "lowvol-v51-capital";
const state = {
  statuses: [],
  market: { day: [], week: [], month: [] },
  tradeHistory: [],
  liveQuote: null,
  period: "day",
  selectedCandle: -1,
  trades: loadJson(TRADES_KEY, []),
  initialCapital: Number(localStorage.getItem(CAPITAL_KEY)) || 1_000_000,
};

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART = { width: 620, height: 300, left: 10, right: 52, top: 16, bottom: 30 };
const byId = (id) => document.getElementById(id);
const money = (value) => new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 0,
}).format(value);
const pct = (value) => `${(value * 100).toFixed(2)}%`;
const actionLabel = (action) => action === "BUY" ? "买入" : action === "SELL" ? "卖出" : "持有";

function eastmoneyQuote(secid) {
  return new Promise((resolve, reject) => {
    const callback = `emQuote${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const script = document.createElement("script");
    const cleanup = () => {
      delete window[callback];
      script.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("quote timeout"));
    }, 8000);
    window[callback] = (payload) => {
      clearTimeout(timer);
      const data = payload?.data;
      cleanup();
      if (!data || !Number.isFinite(Number(data.f43)) || !Number.isFinite(Number(data.f60))) {
        reject(new Error("invalid quote"));
        return;
      }
      resolve({
        price: Number(data.f43) / 1000,
        previousClose: Number(data.f60) / 1000,
        timestamp: Number(data.f86) * 1000,
      });
    };
    script.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("quote unavailable"));
    };
    script.src = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f60,f86&cb=${callback}`;
    document.head.append(script);
  });
}

function beijingParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function quoteLabel(timestamp) {
  const now = beijingParts(new Date());
  const quote = beijingParts(new Date(timestamp));
  const today = `${now.year}-${now.month}-${now.day}`;
  const quoteDay = `${quote.year}-${quote.month}-${quote.day}`;
  const minutes = Number(now.hour) * 60 + Number(now.minute);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(new Date());
  const tradingDay = !["Sat", "Sun"].includes(weekday) && today === quoteDay;
  const open = tradingDay && ((minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900));
  if (open) return "盘中实时价";
  if (tradingDay && minutes >= 900) return "今日收盘价";
  return "最近收盘价";
}

function renderLiveQuote() {
  const latest = state.statuses[0];
  if (!latest) return;
  const days = state.market.day || [];
  const fallbackPrevious = days.length > 1 ? days[days.length - 2].close : latest.close;
  const quote = state.liveQuote || { price: latest.close, previousClose: fallbackPrevious, timestamp: Date.parse(`${latest.tradeDate}T15:00:00+08:00`) };
  const change = quote.previousClose ? quote.price / quote.previousClose - 1 : 0;
  const quoteTime = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(quote.timestamp));
  byId("live-price").textContent = `¥${quote.price.toFixed(3)}`;
  byId("previous-close").textContent = `¥${quote.previousClose.toFixed(3)}`;
  byId("live-change").textContent = pct(change);
  byId("live-change").className = change >= 0 ? "positive" : "negative";
  byId("live-status").textContent = `${quoteLabel(quote.timestamp)} · 行情时间 ${quoteTime}${state.liveQuote ? "" : " · 实时源暂不可用"}`;

  const summary = account(latest, quote.price);
  byId("equity").textContent = money(summary.equity);
  byId("suggestion-amount").textContent = money(Math.abs(summary.gap));
  byId("suggestion-amount").className = summary.gap >= 0 ? "positive" : "negative";
}

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

function svgNode(name, attributes = {}, text = "") {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text) node.textContent = text;
  return node;
}

function tradeCard(trade, className) {
  const row = document.createElement("div");
  row.className = className;
  const badge = document.createElement("span");
  badge.className = `trade-badge ${trade.side === "SELL" ? "sell" : ""}`;
  badge.textContent = actionLabel(trade.side);
  const copy = document.createElement("div");
  const date = document.createElement("strong");
  date.textContent = trade.date;
  const detail = document.createElement("small");
  detail.textContent = `${trade.quantity.toLocaleString()}份 · 目标${Math.round(trade.targetExposure * 100)}% · ${trade.reason}`;
  copy.append(date, detail);
  const price = document.createElement("strong");
  price.textContent = `¥${trade.price.toFixed(3)}`;
  row.append(badge, copy, price);
  return row;
}

function renderStrategyTrades() {
  const list = byId("strategy-trades");
  list.replaceChildren(...state.tradeHistory.map((trade) => tradeCard(trade, "strategy-trade")));
}

function updateQuote(candle) {
  if (!candle) return;
  byId("quote-date").textContent = candle.date;
  byId("quote-open").textContent = candle.open.toFixed(3);
  byId("quote-high").textContent = candle.high.toFixed(3);
  byId("quote-low").textContent = candle.low.toFixed(3);
  byId("quote-close").textContent = candle.close.toFixed(3);
  byId("quote-adj-close").textContent = candle.adjClose.toFixed(3);
  const selected = byId("selected-trades");
  selected.hidden = candle.trades.length === 0;
  selected.replaceChildren(...candle.trades.map((trade) => tradeCard(trade, "selected-trade")));
}

function drawChart() {
  const rows = state.market[state.period] || [];
  const svg = byId("kline-chart");
  svg.replaceChildren();
  if (!rows.length) return;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const prices = rows.flatMap((row) => [row.high, row.low, row.adjClose]);
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const padding = Math.max((rawMax - rawMin) * 0.08, 0.01);
  const minPrice = rawMin - padding;
  const maxPrice = rawMax + padding;
  const y = (price) => CHART.top + (maxPrice - price) / (maxPrice - minPrice) * plotHeight;
  const step = plotWidth / rows.length;
  const candleWidth = Math.max(1.5, Math.min(8, step * 0.58));

  for (let index = 0; index < 5; index += 1) {
    const chartY = CHART.top + plotHeight * index / 4;
    const price = maxPrice - (maxPrice - minPrice) * index / 4;
    svg.append(
      svgNode("line", { x1: CHART.left, x2: CHART.width - CHART.right, y1: chartY, y2: chartY, class: "grid-line" }),
      svgNode("text", { x: CHART.width - CHART.right + 6, y: chartY + 3, class: "axis-label" }, price.toFixed(3)),
    );
  }

  const labelIndexes = [...new Set([0, Math.floor((rows.length - 1) / 3), Math.floor((rows.length - 1) * 2 / 3), rows.length - 1])];
  for (const index of labelIndexes) {
    const chartX = CHART.left + step * (index + 0.5);
    const label = state.period === "month" ? rows[index].date.slice(0, 7) : rows[index].date.slice(5);
    svg.append(svgNode("text", {
      x: chartX,
      y: CHART.height - 8,
      class: "axis-label",
      "text-anchor": index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle",
    }, label));
  }

  const adjPoints = [];
  rows.forEach((row, index) => {
    const chartX = CHART.left + step * (index + 0.5);
    const className = row.close > row.open ? "candle-up" : row.close < row.open ? "candle-down" : "candle-flat";
    const bodyTop = y(Math.max(row.open, row.close));
    const bodyHeight = Math.max(1.5, Math.abs(y(row.open) - y(row.close)));
    svg.append(
      svgNode("line", { x1: chartX, x2: chartX, y1: y(row.high), y2: y(row.low), class: `candle-wick ${className}` }),
      svgNode("rect", { x: chartX - candleWidth / 2, y: bodyTop, width: candleWidth, height: bodyHeight, rx: 0.7, class: `candle-body ${className}` }),
    );
    adjPoints.push(`${chartX},${y(row.adjClose)}`);
  });
  svg.append(svgNode("polyline", { points: adjPoints.join(" "), class: "adj-line" }));

  rows.forEach((row, index) => {
    const chartX = CHART.left + step * (index + 0.5);
    row.trades.forEach((trade, tradeIndex) => {
      const isBuy = trade.side === "BUY";
      const markerY = isBuy
        ? Math.min(CHART.height - CHART.bottom - 7, y(row.low) + 11 + tradeIndex * 13)
        : Math.max(CHART.top + 7, y(row.high) - 11 - tradeIndex * 13);
      const marker = svgNode("g", { class: `trade-marker ${isBuy ? "buy" : "sell"}` });
      marker.append(
        svgNode("circle", { cx: chartX, cy: markerY, r: 6 }),
        svgNode("text", { x: chartX, y: markerY + 0.5 }, isBuy ? "B" : "S"),
      );
      svg.append(marker);
    });
  });

  const selectedIndex = Math.max(0, Math.min(state.selectedCandle, rows.length - 1));
  const selectedX = CHART.left + step * (selectedIndex + 0.5);
  svg.append(svgNode("line", {
    x1: selectedX,
    x2: selectedX,
    y1: CHART.top,
    y2: CHART.height - CHART.bottom,
    class: "crosshair",
  }));
  updateQuote(rows[selectedIndex]);
}

function renderChart(resetSelection = true) {
  const rows = state.market[state.period] || [];
  if (resetSelection) state.selectedCandle = rows.length - 1;
  for (const button of document.querySelectorAll("[data-period]")) {
    const active = button.dataset.period === state.period;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  drawChart();
}

function selectCandle(event) {
  const rows = state.market[state.period] || [];
  if (!rows.length) return;
  const rect = byId("kline-chart").getBoundingClientRect();
  const chartX = (event.clientX - rect.left) / rect.width * CHART.width;
  const plotWidth = CHART.width - CHART.left - CHART.right;
  state.selectedCandle = Math.max(0, Math.min(
    rows.length - 1,
    Math.floor((chartX - CHART.left) / plotWidth * rows.length),
  ));
  drawChart();
}

function account(latest, markPrice = latest.close) {
  const cash = state.trades.reduce(
    (sum, trade) => sum + (trade.side === "BUY" ? -trade.amount : trade.amount),
    state.initialCapital,
  );
  const shares = state.trades.reduce(
    (sum, trade) => sum + (trade.side === "BUY" ? trade.shares : -trade.shares),
    0,
  );
  const positionValue = shares * markPrice;
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
  const peakAdjClose = latest.close / (1 + latest.drawdown);
  byId("peak-adj-close").textContent = `¥${peakAdjClose.toFixed(3)}`;
  byId("entry-first-price").textContent = `¥${(peakAdjClose * 0.93).toFixed(3)}`;
  byId("entry-full-price").textContent = `¥${(peakAdjClose * 0.88).toFixed(3)}`;
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
  renderChart();
  renderStrategyTrades();
  renderLiveQuote();
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
  const period = event.target.closest("[data-period]")?.dataset.period;
  if (period) {
    state.period = period;
    renderChart();
  }
  if (event.target.id === "notice") event.target.hidden = true;
});

byId("kline-chart").addEventListener("pointerdown", selectCandle);
byId("kline-chart").addEventListener("pointermove", (event) => {
  if (event.pointerType === "mouse") selectCandle(event);
});
byId("kline-chart").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  const rows = state.market[state.period] || [];
  const direction = event.key === "ArrowLeft" ? -1 : 1;
  state.selectedCandle = Math.max(0, Math.min(rows.length - 1, state.selectedCandle + direction));
  drawChart();
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
    state.market = payload.market || state.market;
    state.tradeHistory = Array.isArray(payload.tradeHistory) ? payload.tradeHistory : [];
    render();
    eastmoneyQuote("1.512890")
      .then((quote) => {
        state.liveQuote = quote;
        renderLiveQuote();
      })
      .catch(() => renderLiveQuote());
  })
  .catch(() => showNotice("每日数据暂时无法读取，请稍后刷新"));
