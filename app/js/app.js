"use strict";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Defaults — overridden at startup by config/config.json
var COLORS = [
  { fill: "rgba(118, 185, 0, 0.55)", stroke: "#76b900" },
  { fill: "rgba(239, 68, 68, 0.55)", stroke: "rgb(239, 68, 68)" },
  { fill: "rgba(59, 130, 246, 0.55)", stroke: "rgb(59, 130, 246)" },
  { fill: "rgba(245, 158, 11, 0.55)", stroke: "rgb(245, 158, 11)" },
  { fill: "rgba(168, 85, 247, 0.55)", stroke: "rgb(168, 85, 247)" },
  { fill: "rgba(20, 184, 166, 0.55)", stroke: "rgb(20, 184, 166)" },
  { fill: "rgba(236, 72, 153, 0.55)", stroke: "rgb(236, 72, 153)" },
  { fill: "rgba(234, 179, 8, 0.55)", stroke: "rgb(234, 179, 8)" },
  { fill: "rgba(99, 102, 241, 0.55)", stroke: "rgb(99, 102, 241)" },
  { fill: "rgba(249, 115, 22, 0.55)", stroke: "rgb(249, 115, 22)" },
  { fill: "rgba(14, 165, 233, 0.55)", stroke: "rgb(14, 165, 233)" },
  { fill: "rgba(139, 92, 246, 0.55)", stroke: "rgb(139, 92, 246)" },
];
var EXPOSURE_MAP = {};
var EXPOSURE_DISPLAY = [];
var SYMBOL_ORDER = [];
var GAINS_METHOD = "FIFO";
var REBALANCING_CONFIG = { categories: [], targets: {}, tradeable: null };
var MARGIN_LOAN_DISPLAY = "proportional";
var ANALYSIS_WINDOW = "1Y";
var GAINS_WINDOW = "YTD";

var PAD = { top: 12, right: 8, bottom: 28, left: 72 };
var ASPECT = 0.45;

// Formatting helpers — loaded from js/fmt.js via Portfolio namespace
var MONTHS = Portfolio.MONTHS;
var fmtDollar = Portfolio.fmtDollar;
var fmtShort = Portfolio.fmtShort;
var fmtDate = Portfolio.fmtDate;
var fmtDateLong = Portfolio.fmtDateLong;
var fmtShares = Portfolio.fmtShares;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function fetchJSON(url) {
  var res = await fetch(url);
  if (!res.ok) throw new Error("Failed to fetch " + url + ": " + res.status);
  return res.json();
}

// Config parser — loaded from js/config.js via Portfolio namespace
var parseConfig = Portfolio.parseConfig;

/**
 * Load data/config.json and apply to globals. Failures are non-fatal (defaults remain).
 * Structure: { colors: [...], exposure: { allocations: [...], display: [...] } }
 */
async function loadConfig() {
  try {
    var cfg = await fetchJSON("data/config.json").catch(function () { return null; });
    if (!cfg) return;
    var parsed = parseConfig(cfg);
    if (parsed.colors) COLORS = parsed.colors;
    if (parsed.exposureMap) EXPOSURE_MAP = parsed.exposureMap;
    if (parsed.exposureDisplay) EXPOSURE_DISPLAY = parsed.exposureDisplay;
    if (parsed.symbolOrder) SYMBOL_ORDER = parsed.symbolOrder;
    if (parsed.gainsMethod) GAINS_METHOD = parsed.gainsMethod;
    if (parsed.rebalancingConfig) REBALANCING_CONFIG = parsed.rebalancingConfig;
    if (parsed.marginLoanDisplay) MARGIN_LOAN_DISPLAY = parsed.marginLoanDisplay;
  } catch (e) {
    // Config load failure is non-fatal; defaults remain
  }
}

// Data processing — loaded from js/data.js via Portfolio namespace
var processData = Portfolio.processData;
var niceMax = Portfolio.niceMax;
var filterData = Portfolio.filterData;
var rebuildCumulatives = Portfolio.rebuildCumulatives;
var applySymbolOrder = Portfolio.applySymbolOrder;

// Retirement account interpolation — loaded from js/retirement.js via Portfolio namespace
var mergeRetirement = Portfolio.mergeRetirement;

// Computed assets — loaded from js/assets.js via Portfolio namespace
var computeMortgageEquity = Portfolio.computeMortgageEquity;
var computeIBondValue = Portfolio.computeIBondValue;
var mergeAssets = Portfolio.mergeAssets;

// Capital gains computation — loaded from js/gains.js via Portfolio namespace
var computeGains = Portfolio.computeGains;

// Return metrics — loaded from js/returns.js via Portfolio namespace
var computeReturns = Portfolio.computeReturns;

// UI utilities — loaded from js/ui-utils.js via Portfolio namespace
var localDateString = Portfolio.localDateString;
var tableArrowNav = Portfolio.tableArrowNav;
var historyDeltaStyle = Portfolio.historyDeltaStyle;

// Tools — loaded from js/tools.js via Portfolio namespace
var buildToolsPanel = Portfolio.buildToolsPanel;

// ---------------------------------------------------------------------------
// Canvas setup
// ---------------------------------------------------------------------------

function setupCanvas(canvas, wrapEl) {
  var dpr = window.devicePixelRatio || 1;
  var cssW = wrapEl.clientWidth;
  var cssH = Math.round(cssW * ASPECT);

  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";

  var ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  return { ctx: ctx, w: cssW, h: cssH };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function drawChart(chart, data, hoverIdx) {
  var ctx = chart.ctx;
  var w = chart.w;
  var h = chart.h;
  var cd = data.chartData;
  var len = cd.length;
  if (len < 2) return;

  PAD.left = w < 420 ? 54 : 72;
  var pL = PAD.left,
    pT = PAD.top;
  var pW = w - PAD.left - PAD.right;
  var pH = h - PAD.top - PAD.bottom;

  ctx.clearRect(0, 0, w, h);

  function xFor(i) {
    return pL + (i / (len - 1)) * pW;
  }
  function yFor(v) {
    return pT + pH - (v / data.yMax) * pH;
  }

  // Grid lines & Y labels
  var tickCount = 5;
  var tickStep = data.yMax / tickCount;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.font = "11px system-ui, sans-serif";

  for (var t = 0; t <= tickCount; t++) {
    var val = t * tickStep;
    var y = yFor(val);
    ctx.beginPath();
    ctx.moveTo(pL, y);
    ctx.lineTo(pL + pW, y);
    ctx.strokeStyle = "#e5e5e5";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#888";
    ctx.fillText(fmtShort(val), pL - 8, y);
  }

  // X labels — fit as many as the available width can comfortably hold
  var labelCount = Math.min(Math.max(2, Math.floor(pW / 60)), 8, len);
  var labelStep = Math.floor(len / labelCount);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (var li = 0; li < len; li += labelStep) {
    var lx = xFor(li);
    ctx.fillStyle = "#888";
    ctx.fillText(fmtDate(cd[li].date), lx, pT + pH + 8);
    // small tick
    ctx.beginPath();
    ctx.moveTo(lx, pT + pH);
    ctx.lineTo(lx, pT + pH + 4);
    ctx.strokeStyle = "#ccc";
    ctx.stroke();
  }

  // Stacked areas — draw topmost first so bottom layers paint over
  var symbols = data.symbols;
  var liabSet = {};
  if (data.liabilitySymbols) {
    for (var lsi = 0; lsi < data.liabilitySymbols.length; lsi++) {
      liabSet[data.liabilitySymbols[lsi]] = true;
    }
  }
  for (var si = symbols.length - 1; si >= 0; si--) {
    if (liabSet[symbols[si]]) continue; // skip liability bands
    ctx.beginPath();
    // Top edge (cumulative[si])
    for (var di = 0; di < len; di++) {
      var px = xFor(di);
      var py = yFor(cd[di].cumulative[si]);
      if (di === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    // Bottom edge (cumulative[si-1] or 0)
    for (var di2 = len - 1; di2 >= 0; di2--) {
      var bx = xFor(di2);
      var by = si > 0 ? yFor(cd[di2].cumulative[si - 1]) : yFor(0);
      ctx.lineTo(bx, by);
    }
    ctx.closePath();

    var ci = si % COLORS.length;
    ctx.fillStyle = COLORS[ci].fill;
    ctx.fill();

    // Stroke just the top edge
    ctx.beginPath();
    for (var di3 = 0; di3 < len; di3++) {
      var sx = xFor(di3);
      var sy = yFor(cd[di3].cumulative[si]);
      if (di3 === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.strokeStyle = COLORS[ci].stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Baseline
  ctx.beginPath();
  ctx.moveTo(pL, yFor(0));
  ctx.lineTo(pL + pW, yFor(0));
  ctx.strokeStyle = "#ccc";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Hover line
  if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < len) {
    var hx = xFor(hoverIdx);
    ctx.beginPath();
    ctx.moveTo(hx, pT);
    ctx.lineTo(hx, pT + pH);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#555";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------

function updateDetail(data, idx) {
  var pt = data.chartData[idx];
  var prev = idx > 0 ? data.chartData[idx - 1] : null;
  var first = data.chartData[0];
  var symbols = data.symbols;

  document.getElementById("detail").classList.remove("hidden");
  document.getElementById("detail-date").textContent = fmtDateLong(pt.date);

  var tbody = document.getElementById("detail-body");
  tbody.innerHTML = "";

  for (var i = 0; i < symbols.length; i++) {
    var sym = symbols[i];
    var shares = pt.positions[sym] || 0;
    var value = pt.values[sym] || 0;
    if (value < 0.01 && value > -0.01 && shares < 1e-4) continue;
    var price = parseFloat(pt.prices[sym]) || 0;

    var tr = document.createElement("tr");

    // Asset cell with color swatch
    var tdAsset = document.createElement("td");
    var swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = COLORS[i % COLORS.length].stroke;
    tdAsset.appendChild(swatch);
    tdAsset.appendChild(document.createTextNode(sym));
    tr.appendChild(tdAsset);

    var tdShares = document.createElement("td");
    tdShares.className = "col-shares";
    tdShares.textContent = shares >= 1e-4 ? fmtShares(shares) : "\u2014";
    tr.appendChild(tdShares);

    var tdPrice = document.createElement("td");
    tdPrice.className = "col-price";
    tdPrice.textContent = price > 0 && shares >= 1e-4 ? fmtDollar(price) : "\u2014";
    tr.appendChild(tdPrice);

    var tdVal = document.createElement("td");
    tdVal.textContent = fmtDollar(value);
    tr.appendChild(tdVal);

    var tdChg = document.createElement("td");
    if (prev) {
      var prevValue = prev.values[sym] || 0;
      var chg = value - prevValue;
      var sign = chg >= 0 ? "+" : "";
      tdChg.textContent = sign + fmtDollar(chg);
      tdChg.style.color = chg >= 0 ? "#16a34a" : "#dc2626";
    } else {
      tdChg.textContent = "\u2014";
    }
    tr.appendChild(tdChg);

    var tdWinChg = document.createElement("td");
    tdWinChg.className = "col-win-chg";
    var firstValue = first.values[sym] || 0;
    var winChg = value - firstValue;
    var winSign = winChg >= 0 ? "+" : "";
    tdWinChg.textContent = winSign + fmtDollar(winChg);
    tdWinChg.style.color = winChg >= 0 ? "#16a34a" : "#dc2626";
    tr.appendChild(tdWinChg);

    tbody.appendChild(tr);
  }

  document.getElementById("detail-total").textContent = fmtDollar(pt.total);

  var totalChgEl = document.getElementById("detail-change");
  if (prev) {
    var totalChg = pt.total - prev.total;
    var totalSign = totalChg >= 0 ? "+" : "";
    totalChgEl.textContent = totalSign + fmtDollar(totalChg);
    totalChgEl.style.color = totalChg >= 0 ? "#16a34a" : "#dc2626";
  } else {
    totalChgEl.textContent = "\u2014";
  }

  var winTotalEl = document.getElementById("detail-win-chg");
  var winTotal = pt.total - first.total;
  var winTotalSign = winTotal >= 0 ? "+" : "";
  winTotalEl.textContent = winTotalSign + fmtDollar(winTotal);
  winTotalEl.style.color = winTotal >= 0 ? "#16a34a" : "#dc2626";
}

function hideDetail() {
  document.getElementById("detail").classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

// Returns an object with an `update` method so resize can swap in new chart
// dimensions without re-attaching DOM listeners.
function attachListeners(canvas, state, chartRef) {
  var lastIdx = null;
  var rafPending = false;

  function idxFromX(clientX) {
    var pL = PAD.left;
    var pW = chartRef.w - PAD.left - PAD.right;
    var len = state.data.chartData.length;
    var rect = canvas.getBoundingClientRect();
    var mx = clientX - rect.left;
    if (mx < pL || mx > pL + pW) return null;
    var idx = Math.round(((mx - pL) / pW) * (len - 1));
    return Math.max(0, Math.min(len - 1, idx));
  }

  function redraw(idx) {
    drawChart(chartRef, state.data, idx);
    var detailIdx = idx != null ? idx : state.data.chartData.length - 1;
    if (detailIdx >= 0) updateDetail(state.data, detailIdx);
    else hideDetail();
  }

  function onMove(clientX) {
    var idx = idxFromX(clientX);
    if (idx === lastIdx) return;
    lastIdx = idx;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        redraw(lastIdx);
      });
    }
  }

  canvas.addEventListener("mousemove", function (e) {
    onMove(e.clientX);
  });
  canvas.addEventListener("mouseleave", function () {
    lastIdx = null;
    redraw(null);
  });

  canvas.addEventListener(
    "touchmove",
    function (e) {
      e.preventDefault();
      if (e.touches.length > 0) onMove(e.touches[0].clientX);
    },
    { passive: false },
  );
  canvas.addEventListener("touchend", function () {
    lastIdx = null;
    redraw(null);
  });
}

// ---------------------------------------------------------------------------
// History table
// ---------------------------------------------------------------------------

// Shared popup for history cell deltas — touch-friendly alternative to title tooltip.
var _histPopup = null;
var _histPopupCell = null;

function _histGetPopup() {
  if (!_histPopup) {
    _histPopup = document.createElement("div");
    _histPopup.className = "history-cell-popup";
    _histPopup.style.display = "none";
    document.body.appendChild(_histPopup);
    document.addEventListener("click", function () {
      _histHidePopup();
    });
  }
  return _histPopup;
}

function _histHidePopup() {
  if (_histPopup) _histPopup.style.display = "none";
  _histPopupCell = null;
}

function _histShowPopup(td, text) {
  var popup = _histGetPopup();
  popup.textContent = text;
  popup.style.display = "block";

  var rect = td.getBoundingClientRect();
  var left = Math.max(8, Math.min(rect.left, window.innerWidth - 170));
  var below = rect.bottom + 6;
  var above = rect.top - 6;

  if (below + 44 > window.innerHeight && rect.top > 60) {
    popup.style.top = above + "px";
    popup.style.transform = "translateY(-100%)";
  } else {
    popup.style.top = below + "px";
    popup.style.transform = "";
  }
  popup.style.left = left + "px";
  _histPopupCell = td;
}

// ---------------------------------------------------------------------------
// Retirement cell inline edit dialog
// ---------------------------------------------------------------------------

var _histEditDlg = null;
var _histEditState = null; // { date, account, retirement, rebuildAll }

function _histGetEditDialog() {
  if (_histEditDlg) return _histEditDlg;

  var dlg = document.createElement("div");
  dlg.className = "hist-edit-dialog";
  dlg.style.display = "none";

  var header = document.createElement("div");
  header.className = "hist-edit-header";
  dlg.appendChild(header);

  var input = document.createElement("input");
  input.type = "number";
  input.className = "trades-input hist-edit-input";
  input.placeholder = "0.00";
  input.step = "0.01";
  input.min = "0";
  dlg.appendChild(input);

  var btnRow = document.createElement("div");
  btnRow.className = "hist-edit-btn-row";

  var saveBtn = document.createElement("button");
  saveBtn.className = "trades-btn trades-btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", function () { _histEditSave(); });

  var cancelBtn = document.createElement("button");
  cancelBtn.className = "trades-btn";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", function () { _histEditHide(); });

  var delBtn = document.createElement("button");
  delBtn.className = "trades-btn trades-btn-danger";
  delBtn.textContent = "Delete";
  delBtn.addEventListener("click", function () { _histEditDelete(); });

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(delBtn);
  dlg.appendChild(btnRow);

  document.body.appendChild(dlg);

  // Dismiss on outside click
  document.addEventListener("click", function (e) {
    if (_histEditDlg && _histEditDlg.style.display !== "none" && !_histEditDlg.contains(e.target)) {
      _histEditHide();
    }
  });

  // Dismiss on Escape
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") _histEditHide();
  });

  _histEditDlg = dlg;
  return dlg;
}

function _histEditShow(td, date, sym, retirement, rebuildAll, currentVal) {
  var dlg = _histGetEditDialog();
  _histEditState = { date: date, account: sym, retirement: retirement, rebuildAll: rebuildAll };

  dlg.querySelector(".hist-edit-header").textContent = sym + " \u2014 " + date;

  // Pre-populate with existing ground-truth value; fall back to interpolated cell value
  var existingVal = "";
  var values = retirement.values || [];
  for (var i = 0; i < values.length; i++) {
    if (values[i].date === date && values[i].account === sym) {
      existingVal = values[i].value;
      break;
    }
  }

  var input = dlg.querySelector(".hist-edit-input");
  input.value = existingVal !== "" ? existingVal : (currentVal ? currentVal.toFixed(2) : "");

  // Show Delete button only when an existing ground-truth entry exists
  var delBtn = dlg.querySelector(".hist-edit-btn-row").querySelectorAll("button")[2];
  delBtn.style.display = existingVal !== "" ? "" : "none";

  // Position near cell, clamped to viewport
  dlg.style.display = "block";
  var rect = td.getBoundingClientRect();
  var dlgW = 220;
  var dlgH = 120;
  var left = Math.max(8, Math.min(rect.left, window.innerWidth - dlgW - 8));
  var below = rect.bottom + 6;
  if (below + dlgH > window.innerHeight && rect.top > dlgH + 10) {
    dlg.style.top = (rect.top - dlgH - 6) + "px";
  } else {
    dlg.style.top = below + "px";
  }
  dlg.style.left = left + "px";

  input.focus();
  input.select();
}

function _histEditHide() {
  if (_histEditDlg) _histEditDlg.style.display = "none";
  _histEditState = null;
}

function _histEditSave() {
  if (!_histEditState) return;
  var dlg = _histGetEditDialog();
  var rawVal = dlg.querySelector(".hist-edit-input").value.trim();
  if (rawVal === "" || isNaN(parseFloat(rawVal))) return;

  var date = _histEditState.date;
  var account = _histEditState.account;
  var values = _histEditState.retirement.values;
  var found = false;
  for (var i = 0; i < values.length; i++) {
    if (values[i].date === date && values[i].account === account) {
      values[i] = { date: date, account: account, value: rawVal };
      found = true;
      break;
    }
  }
  if (!found) {
    values.push({ date: date, account: account, value: rawVal });
  }
  _histEditPost(_histEditState);
}

function _histEditDelete() {
  if (!_histEditState) return;
  var date = _histEditState.date;
  var account = _histEditState.account;
  var values = _histEditState.retirement.values;
  for (var i = 0; i < values.length; i++) {
    if (values[i].date === date && values[i].account === account) {
      values.splice(i, 1);
      break;
    }
  }
  _histEditPost(_histEditState);
}

function _histEditPost(state) {
  var payload = { accounts: state.retirement.accounts, values: state.retirement.values, contributions: state.retirement.contributions };
  _histEditHide();
  fetch("/api/retirement", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(function (res) { return res.json(); })
    .then(function (result) {
      if (!result.error && state.rebuildAll) state.rebuildAll();
    })
    .catch(function (err) {
      console.error("Failed to save retirement value:", err);
    });
}

function _histAttachEditHandler(td, date, sym, retirement, rebuildAll, currentVal) {
  td.style.cursor = "pointer";

  // Desktop: double-click
  td.addEventListener("dblclick", function (e) {
    e.stopPropagation();
    _histEditShow(td, date, sym, retirement, rebuildAll, currentVal);
  });

  // Mobile: long-press (~600 ms)
  var longPressTimer = null;
  td.addEventListener("touchstart", function () {
    longPressTimer = setTimeout(function () {
      longPressTimer = null;
      _histEditShow(td, date, sym, retirement, rebuildAll, currentVal);
    }, 600);
  }, { passive: true });
  td.addEventListener("touchend", function () {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });
  td.addEventListener("touchmove", function () {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  });
}

function buildHistoryTable(data, retirement, rebuildAll) {
  var container = document.getElementById("panel-table");
  var cd = data.chartData;
  var symbols = data.symbols;

  // Build retirement lookup sets
  var retirementSet = {};
  var gtSet = {};
  var acctHasAnyValues = {};
  if (retirement) {
    var _accts = retirement.accounts || [];
    for (var _ai = 0; _ai < _accts.length; _ai++) {
      retirementSet[_accts[_ai].name] = true;
    }
    var _vals = retirement.values || [];
    for (var _vi = 0; _vi < _vals.length; _vi++) {
      gtSet[_vals[_vi].date + ":" + _vals[_vi].account] = true;
      acctHasAnyValues[_vals[_vi].account] = true;
    }
  }

  // Split symbols into active (current value > 0) vs zero (currently $0, collapsed by default)
  var latestPt = cd.length > 0 ? cd[cd.length - 1] : null;
  var activeSymbols = [], zeroSymbols = [];
  for (var si = 0; si < symbols.length; si++) {
    if (latestPt && (latestPt.values[symbols[si]] || 0) === 0) {
      zeroSymbols.push(symbols[si]);
    } else {
      activeSymbols.push(symbols[si]);
    }
  }
  var hasZeroCols = zeroSymbols.length > 0;

  var table = document.createElement("table");
  table.id = "history-table";

  // Header
  var thead = document.createElement("thead");
  var headerRow = document.createElement("tr");

  var thDate = document.createElement("th");
  thDate.textContent = "Date";
  headerRow.appendChild(thDate);

  for (var i = 0; i < activeSymbols.length; i++) {
    var th = document.createElement("th");
    th.textContent = activeSymbols[i];
    headerRow.appendChild(th);
  }

  if (hasZeroCols) {
    var thExpand = document.createElement("th");
    thExpand.className = "history-expand-col";
    var expandBtn = document.createElement("button");
    expandBtn.className = "history-expand-btn";
    expandBtn.textContent = "+";
    expandBtn.title = "Show columns with $0 current value: " + zeroSymbols.join(", ");
    expandBtn.addEventListener("click", function () {
      var expanding = !table.classList.contains("expanded");
      table.classList.toggle("expanded");
      expandBtn.textContent = expanding ? "−" : "+";
      expandBtn.title = expanding
        ? "Hide columns with $0 current value"
        : "Show columns with $0 current value: " + zeroSymbols.join(", ");
    });
    thExpand.appendChild(expandBtn);
    headerRow.appendChild(thExpand);

    for (var i2 = 0; i2 < zeroSymbols.length; i2++) {
      var thZ = document.createElement("th");
      thZ.textContent = zeroSymbols[i2];
      thZ.className = "zero-col";
      headerRow.appendChild(thZ);
    }
  }

  var thTotal = document.createElement("th");
  thTotal.textContent = "Total";
  headerRow.appendChild(thTotal);

  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body — most recent first
  var tbody = document.createElement("tbody");
  for (var j = cd.length - 1; j >= 0; j--) {
    var pt = cd[j];
    var prev = j > 0 ? cd[j - 1] : null;
    var tr = document.createElement("tr");

    var rowDate = pt.date.slice(0, 10);
    var tdDate = document.createElement("td");
    tdDate.textContent = rowDate;
    tr.appendChild(tdDate);

    for (var k = 0; k < activeSymbols.length; k++) {
      var sym = activeSymbols[k];
      var val = pt.values[sym] || 0;
      var td = document.createElement("td");
      if (retirementSet[sym] && !acctHasAnyValues[sym]) {
        td.textContent = "—";
        td.style.color = "#9ca3af";
        td.title = "No ground-truth values recorded yet — double-click to add one";
      } else {
        td.textContent = fmtDollar(val);
        if (retirementSet[sym] && gtSet[rowDate + ":" + sym]) {
          td.style.fontWeight = "bold";
        }
        if (prev !== null) {
          var prevVal = prev.values[sym] || 0;
          historyColorCell(td, val, prevVal);
        }
      }
      if (retirementSet[sym] && retirement) {
        _histAttachEditHandler(td, rowDate, sym, retirement, rebuildAll, val);
      }
      tr.appendChild(td);
    }

    if (hasZeroCols) {
      var tdPlaceholder = document.createElement("td");
      tdPlaceholder.className = "history-expand-col";
      tr.appendChild(tdPlaceholder);

      for (var m = 0; m < zeroSymbols.length; m++) {
        var symZ = zeroSymbols[m];
        var valZ = pt.values[symZ] || 0;
        var tdZ = document.createElement("td");
        tdZ.className = "zero-col";
        if (retirementSet[symZ] && !acctHasAnyValues[symZ]) {
          tdZ.textContent = "—";
          tdZ.style.color = "#9ca3af";
          tdZ.title = "No ground-truth values recorded yet — double-click to add one";
        } else {
          tdZ.textContent = fmtDollar(valZ);
          if (retirementSet[symZ] && gtSet[rowDate + ":" + symZ]) {
            tdZ.style.fontWeight = "bold";
          }
          if (prev !== null) {
            var prevValZ = prev.values[symZ] || 0;
            historyColorCell(tdZ, valZ, prevValZ);
          }
        }
        if (retirementSet[symZ] && retirement) {
          _histAttachEditHandler(tdZ, rowDate, symZ, retirement, rebuildAll, valZ);
        }
        tr.appendChild(tdZ);
      }
    }

    var tdTotal = document.createElement("td");
    tdTotal.textContent = fmtDollar(pt.total);
    if (prev !== null) {
      historyColorCell(tdTotal, pt.total, prev.total);
    }
    tr.appendChild(tdTotal);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  container.appendChild(table);
}

// Apply a red→white→green background and a delta tooltip to a history cell.
function historyColorCell(td, val, prevVal) {
  var s = historyDeltaStyle(val, prevVal);
  td.style.background = s.background;
  td.title = s.title;
  td.style.cursor = "default";
  td.addEventListener("click", function (e) {
    e.stopPropagation();
    if (_histPopupCell === td) {
      _histHidePopup();
    } else {
      _histShowPopup(td, s.title);
    }
  });
}

// ---------------------------------------------------------------------------
// Exposure panel
// ---------------------------------------------------------------------------

function computeExposure(data) {
  var cd = data.chartData;
  if (cd.length === 0) return null;

  var latest = cd[cd.length - 1];
  var symbols = data.symbols;
  var buckets = {};

  for (var i = 0; i < symbols.length; i++) {
    var sym = symbols[i];
    var val = latest.values[sym] || 0;
    var map = EXPOSURE_MAP[sym];
    if (!map) continue;
    for (var cat in map) {
      buckets[cat] = (buckets[cat] || 0) + val * map[cat];
    }
  }

  var mappedTotal = 0;
  for (var cat in buckets) mappedTotal += buckets[cat];

  return { buckets: buckets, total: mappedTotal };
}

function drawExposureChart(wrap, rows, barColors, total, onHighlight) {
  if (total <= 0) return;
  var dpr = window.devicePixelRatio || 1;
  var size = 280;
  var cx = size / 2, cy = size / 2;
  var r = size / 2 - 6;

  var canvas = document.createElement("canvas");
  canvas.width  = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width  = size + "px";
  canvas.style.height = size + "px";

  wrap.appendChild(canvas);

  var ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  var innerR1 = r * 0.27;
  var innerR2 = r * 0.64;
  var outerR1 = r * 0.69;
  var outerR2 = r * 0.95;

  var GAP   = 0.018;
  var START = -Math.PI / 2;

  var innerSlices = [];
  var lastParentIdx = -1;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var color = barColors[row.name] || "#888";
    if (!row.indent) {
      innerSlices.push({ name: row.name, value: row.value, color: color, isGroup: row.group, children: [] });
      lastParentIdx = row.group ? innerSlices.length - 1 : -1;
    } else {
      if (lastParentIdx >= 0) {
        innerSlices[lastParentIdx].children.push({ name: row.name, value: row.value, color: color });
      }
    }
  }

  var N = innerSlices.length;
  if (N === 0) return;
  var totalSweep = 2 * Math.PI - N * GAP;

  var angle = START;
  for (var i = 0; i < N; i++) {
    var s = innerSlices[i];
    s.sweep      = (s.value / total) * totalSweep;
    s.startAngle = angle + GAP / 2;
    s.endAngle   = s.startAngle + s.sweep;
    angle += s.sweep + GAP;
  }

  // Build flat segments array for hit-testing
  var segments = [];
  for (var i = 0; i < N; i++) {
    var s = innerSlices[i];
    segments.push({ name: s.name, value: s.value, color: s.color, r1: innerR1, r2: innerR2, startAngle: s.startAngle, endAngle: s.endAngle });

    if (s.children.length === 0) continue;

    var childTotal = 0;
    for (var j = 0; j < s.children.length; j++) childTotal += s.children[j].value;
    var parentSpan = s.endAngle - s.startAngle;
    var CHILD_GAP = s.children.length > 1 ? 0.008 : 0;
    var childSweepTotal = parentSpan - CHILD_GAP * (s.children.length - 1);

    var ca = s.startAngle;
    for (var j = 0; j < s.children.length; j++) {
      var c = s.children[j];
      var cs = (childTotal > 0 ? c.value / childTotal : 1 / s.children.length) * childSweepTotal;
      segments.push({ name: c.name, value: c.value, color: c.color, r1: outerR1, r2: outerR2, startAngle: ca, endAngle: ca + cs });
      ca += cs + CHILD_GAP;
    }
  }

  function drawSector(r1, r2, a1, a2, fillColor, highlight) {
    if (a2 - a1 < 0.001) return;
    ctx.beginPath();
    ctx.arc(cx, cy, r2, a1, a2);
    ctx.arc(cx, cy, r1, a2, a1, true);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
    if (highlight) {
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  function render(hoveredSeg) {
    ctx.clearRect(0, 0, size, size);
    for (var k = 0; k < segments.length; k++) {
      var seg = segments[k];
      drawSector(seg.r1, seg.r2, seg.startAngle, seg.endAngle, seg.color, seg === hoveredSeg);
    }
  }

  render(null);

  function hitTest(mx, my) {
    var dx = mx - cx, dy = my - cy;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var rawAngle = Math.atan2(dy, dx);
    if (rawAngle < START) rawAngle += 2 * Math.PI;
    for (var k = 0; k < segments.length; k++) {
      var seg = segments[k];
      if (dist >= seg.r1 && dist <= seg.r2 && rawAngle >= seg.startAngle && rawAngle <= seg.endAngle) {
        return seg;
      }
    }
    return null;
  }

  var lastHovered = null;

  canvas.addEventListener("mousemove", function(e) {
    var rect = canvas.getBoundingClientRect();
    var seg = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    if (seg !== lastHovered) {
      lastHovered = seg;
      render(seg);
      canvas.style.cursor = seg ? "pointer" : "default";
      onHighlight(seg ? seg.name : null);
    }
  });

  canvas.addEventListener("mouseleave", function() {
    if (lastHovered !== null) {
      lastHovered = null;
      render(null);
      onHighlight(null);
    }
  });

  canvas.addEventListener("touchstart", function(e) {
    var touch = e.touches[0];
    var rect = canvas.getBoundingClientRect();
    var seg = hitTest(touch.clientX - rect.left, touch.clientY - rect.top);
    lastHovered = seg;
    render(seg);
    onHighlight(seg ? seg.name : null);
  }, { passive: true });

  canvas.addEventListener("touchmove", function(e) {
    var touch = e.touches[0];
    var rect = canvas.getBoundingClientRect();
    var seg = hitTest(touch.clientX - rect.left, touch.clientY - rect.top);
    if (seg !== lastHovered) {
      lastHovered = seg;
      render(seg);
      onHighlight(seg ? seg.name : null);
    }
  }, { passive: true });
}

function buildExposurePanel(data, trades, retirement, assets) {
  var container = document.getElementById("panel-exposure");

  // --- Time window dropdown ---
  var header = document.createElement("div");
  header.className = "analysis-header";

  var sel = document.createElement("select");
  sel.className = "analysis-window-select";
  var prevYearLabel = String(new Date().getFullYear() - 1);
  ["1M", "90D", "YTD", "PREV_YEAR", "1Y", "2Y", "All"].forEach(function (w) {
    var opt = document.createElement("option");
    opt.value = w;
    opt.textContent = w === "90D" ? "90 Days" : w === "1M" ? "1 Month" :
      w === "YTD" ? "YTD" : w === "PREV_YEAR" ? prevYearLabel :
      w === "1Y" ? "1 Year" : w === "2Y" ? "2 Years" : "All";
    if (w === ANALYSIS_WINDOW) opt.selected = true;
    sel.appendChild(opt);
  });
  header.appendChild(sel);

  // --- Return metrics section ---
  var metricsEl = document.createElement("div");
  metricsEl.className = "analysis-metrics";

  var expandedMetricGroups = {}; // group name → true when expanded

  function renderMetrics() {
    var cd = data.chartData;
    if (cd.length === 0) { metricsEl.innerHTML = ""; return; }

    var last = cd[cd.length - 1].date;
    var cutoff;
    if (ANALYSIS_WINDOW === "All") {
      cutoff = cd[0].date;
    } else if (ANALYSIS_WINDOW === "YTD") {
      cutoff = last.slice(0, 4) + "-01-01";
    } else if (ANALYSIS_WINDOW === "PREV_YEAR") {
      var prevYear = String(parseInt(last.slice(0, 4), 10) - 1);
      cutoff = prevYear + "-01-01";
      last = prevYear + "-12-31";
    } else {
      var dayMap = { "1M": 30, "90D": 90, "1Y": 365, "2Y": 730 };
      var d = new Date(last);
      d.setDate(d.getDate() - (dayMap[ANALYSIS_WINDOW] || 365));
      cutoff = d.toISOString().slice(0, 10);
    }

    // Build symbol groupings: retirement accounts and mortgage assets get separate treatment
    var retirementNamesMap = {};
    if (retirement && retirement.accounts) {
      for (var ri = 0; ri < retirement.accounts.length; ri++) {
        retirementNamesMap[retirement.accounts[ri].name] = true;
      }
    }
    var mortgageNamesMap = {};
    if (assets) {
      for (var ai = 0; ai < assets.length; ai++) {
        if (assets[ai].type === "mortgage") mortgageNamesMap[assets[ai].name] = true;
      }
    }
    var brokerageSymbols = [];
    for (var bsi = 0; bsi < data.symbols.length; bsi++) {
      var bsym = data.symbols[bsi];
      if (!retirementNamesMap[bsym] && !mortgageNamesMap[bsym]) brokerageSymbols.push(bsym);
    }

    // Build a synthetic [{date, total}] slice using only the given symbols
    function makeSlice(symbols) {
      var result = [];
      for (var i = 0; i < cd.length; i++) {
        var total = 0;
        for (var j = 0; j < symbols.length; j++) total += cd[i].values[symbols[j]] || 0;
        result.push({ date: cd[i].date, total: total });
      }
      return result;
    }

    // Groups: brokerage investments first, then each retirement account.
    var bt = trades || [];
    var groups = [{ name: "Investments", symbols: brokerageSymbols, trades: bt }];
    if (retirement && retirement.accounts) {
      for (var gi = 0; gi < retirement.accounts.length; gi++) {
        var acct = retirement.accounts[gi];
        var acctTrades = [];
        if (retirement.contributions) {
          for (var ci = 0; ci < retirement.contributions.length; ci++) {
            var contrib = retirement.contributions[ci];
            if (contrib.account !== acct.name) continue;
            acctTrades.push({ date: contrib.date, quantity: "1", price: String(contrib.amount).replace(/,/g, ""), type: "buy" });
          }
        }
        groups.push({ name: acct.name, symbols: [acct.name], trades: acctTrades });
      }
    }

    function fmt(v) {
      if (v === null || !isFinite(v)) return "\u2014";
      var sign = v >= 0 ? "+" : "";
      return sign + (v * 100).toFixed(1) + "%";
    }

    metricsEl.innerHTML = "";
    var table = document.createElement("table");
    table.className = "analysis-metrics-table";

    function makeMetricTd(val) {
      var td = document.createElement("td");
      td.className = "analysis-metric-value";
      td.textContent = fmt(val);
      if (val !== null && isFinite(val)) {
        td.style.color = val >= 0 ? "#16a34a" : "#dc2626";
      }
      return td;
    }

    function getActiveSymbols(symbols, windowStart, windowEnd) {
      var active = {};
      for (var i = 0; i < cd.length; i++) {
        var dt = cd[i].date;
        if (dt < windowStart || dt > windowEnd) continue;
        for (var j = 0; j < symbols.length; j++) {
          if ((cd[i].values[symbols[j]] || 0) > 0) active[symbols[j]] = true;
        }
      }
      return symbols.filter(function(s) { return active[s]; });
    }

    // Two-row thead: group headers + column sub-headers
    var thead = document.createElement("thead");

    var hdr1 = document.createElement("tr");
    var thLabel = document.createElement("th");
    thLabel.className = "analysis-metric-label";
    thLabel.setAttribute("rowspan", "2");
    hdr1.appendChild(thLabel);
    var thAnn = document.createElement("th");
    thAnn.className = "analysis-metric-group-header";
    thAnn.setAttribute("colspan", "2");
    thAnn.textContent = "Annualized";
    hdr1.appendChild(thAnn);
    var thCum = document.createElement("th");
    thCum.className = "analysis-metric-group-header";
    thCum.setAttribute("colspan", "2");
    thCum.textContent = "Cumulative";
    hdr1.appendChild(thCum);
    thead.appendChild(hdr1);

    var hdr2 = document.createElement("tr");
    ["TWR", "XIRR", "TWR", "XIRR"].forEach(function(h) {
      var th = document.createElement("th");
      th.className = "analysis-metric-value";
      th.textContent = h;
      hdr2.appendChild(th);
    });
    thead.appendChild(hdr2);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");

    groups.forEach(function(group) {
      var isExpandable = group.symbols.length > 1;
      var slice = makeSlice(group.symbols);
      var result = computeReturns(slice, group.trades, cutoff, last);

      var tr = document.createElement("tr");
      var tdLabel = document.createElement("td");
      tdLabel.className = "analysis-metric-label";

      var btn;
      if (isExpandable) {
        btn = document.createElement("button");
        btn.textContent = "+";
        btn.className = "gains-expand-btn";
        tdLabel.appendChild(btn);
      }
      tdLabel.appendChild(document.createTextNode(group.name));
      tr.appendChild(tdLabel);
      tr.appendChild(makeMetricTd(result.twr));
      tr.appendChild(makeMetricTd(result.xirr));
      tr.appendChild(makeMetricTd(result.twrCumulative));
      tr.appendChild(makeMetricTd(result.xirrCumulative));
      tbody.appendChild(tr);

      if (isExpandable) {
        var activeSyms = getActiveSymbols(group.symbols, cutoff, last);
        var subRows = [];

        activeSyms.forEach(function(sym) {
          var symSlice = makeSlice([sym]);
          var symTrades = (group.trades || []).filter(function(t) { return t.symbol === sym; });
          var symResult = computeReturns(symSlice, symTrades, cutoff, last);

          var subTr = document.createElement("tr");
          subTr.className = "analysis-metrics-sub-row hidden";
          var subLabel = document.createElement("td");
          subLabel.className = "analysis-metric-label analysis-metric-sub-label";
          subLabel.textContent = sym;
          subTr.appendChild(subLabel);
          subTr.appendChild(makeMetricTd(symResult.twr));
          subTr.appendChild(makeMetricTd(symResult.xirr));
          subTr.appendChild(makeMetricTd(symResult.twrCumulative));
          subTr.appendChild(makeMetricTd(symResult.xirrCumulative));
          tbody.appendChild(subTr);
          subRows.push(subTr);
        });

        (function(expandBtn, rows, groupName) {
          if (expandedMetricGroups[groupName]) {
            rows.forEach(function(r) { r.classList.remove("hidden"); });
            expandBtn.textContent = "\u2212";
          }
          expandBtn.addEventListener("click", function() {
            var expanded = expandBtn.textContent === "\u2212";
            rows.forEach(function(r) { r.classList.toggle("hidden", expanded); });
            expandBtn.textContent = expanded ? "+" : "\u2212";
            expandedMetricGroups[groupName] = !expanded;
          });
        })(btn, subRows, group.name);
      }
    });

    table.appendChild(tbody);
    metricsEl.appendChild(table);
  }

  renderMetrics();

  sel.addEventListener("change", function () {
    ANALYSIS_WINDOW = sel.value;
    renderMetrics();
  });

  // --- Existing exposure content ---
  var exp = computeExposure(data);
  if (!exp) {
    container.appendChild(header);
    container.appendChild(metricsEl);
    return;
  }

  var total = exp.total;
  var b = exp.buckets;

  var rows = [];
  var barColors = {};
  for (var di = 0; di < EXPOSURE_DISPLAY.length; di++) {
    var d = EXPOSURE_DISPLAY[di];
    var value;
    if (d.subcategories) {
      // Group row: sum the listed subcategories
      var parts = d.subcategories.split(",");
      value = 0;
      for (var si = 0; si < parts.length; si++) {
        value += b[parts[si].trim()] || 0;
      }
    } else {
      value = b[d.category || d.name] || 0;
    }
    var name = d.name;
    rows.push({
      name: name,
      value: value,
      indent: d.indent === true || d.indent === "true",
      group: !!d.subcategories,
    });
    barColors[name] = d.color || "#888";
  }

  var table = document.createElement("table");
  table.id = "exposure-table";

  var thead = document.createElement("thead");
  var hr = document.createElement("tr");
  var hLabels = ["Category", "Value", "%"];
  for (var i = 0; i < hLabels.length; i++) {
    var th = document.createElement("th");
    th.textContent = hLabels[i];
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  var trByName = {};
  var tbody = document.createElement("tbody");
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    var tr = document.createElement("tr");
    if (r.indent) tr.className = "indent";
    trByName[r.name] = tr;

    var tdName = document.createElement("td");
    var swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.backgroundColor = barColors[r.name] || "#888";
    if (r.indent) swatch.style.opacity = "0.7";
    tdName.appendChild(swatch);
    tdName.appendChild(document.createTextNode(r.name));
    if (r.group) tdName.style.fontWeight = "600";
    tr.appendChild(tdName);

    var tdVal = document.createElement("td");
    tdVal.textContent = fmtDollar(r.value);
    tr.appendChild(tdVal);

    var pct = total > 0 ? (r.value / total) * 100 : 0;
    var tdPct = document.createElement("td");
    tdPct.textContent = pct.toFixed(1) + "%";
    tr.appendChild(tdPct);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  var tfoot = document.createElement("tfoot");
  var fr = document.createElement("tr");
  var ftd1 = document.createElement("td");
  ftd1.textContent = "Total";
  fr.appendChild(ftd1);
  var ftd2 = document.createElement("td");
  ftd2.textContent = fmtDollar(total);
  fr.appendChild(ftd2);
  var ftd3 = document.createElement("td");
  ftd3.textContent = "100.0%";
  fr.appendChild(ftd3);
  tfoot.appendChild(fr);
  table.appendChild(tfoot);

  function onHighlight(name) {
    for (var n in trByName) {
      trByName[n].classList.toggle("highlighted", n === name);
    }
  }

  var chartWrap = document.createElement("div");
  chartWrap.id = "exposure-chart-wrap";
  container.appendChild(chartWrap);
  drawExposureChart(chartWrap, rows, barColors, total, onHighlight);

  var tableWrap = document.createElement("div");
  tableWrap.id = "exposure-table-wrap";
  tableWrap.appendChild(table);
  container.appendChild(tableWrap);

  // Warn about symbols with value but no allocation config
  var unallocated = [];
  var latest = data.chartData[data.chartData.length - 1];
  for (var ui = 0; ui < data.symbols.length; ui++) {
    var usym = data.symbols[ui];
    if (!EXPOSURE_MAP[usym] && (latest.values[usym] || 0) > 0) {
      unallocated.push(usym);
    }
  }
  if (unallocated.length > 0) {
    var notice = document.createElement("p");
    notice.className = "exposure-unallocated-notice";
    notice.textContent = "Note: " + unallocated.join(", ") +
      (unallocated.length === 1 ? " has" : " have") +
      " no allocation configured and " +
      (unallocated.length === 1 ? "is" : "are") +
      " excluded from this breakdown. Add " +
      (unallocated.length === 1 ? "an entry" : "entries") +
      " to config.json \u2192 exposure.allocations to include " +
      (unallocated.length === 1 ? "it" : "them") + ".";
    container.appendChild(notice);
  }

  container.appendChild(header);
  container.appendChild(metricsEl);
}

// ---------------------------------------------------------------------------
// Gains panel
// ---------------------------------------------------------------------------

function buildGainsPanel(gainsData) {
  var container = document.getElementById("panel-gains");
  container.innerHTML = "";

  var realized = gainsData.realized;
  var donated = gainsData.donated || [];
  var unrealized = gainsData.unrealized;
  var summary = gainsData.summary;

  function makeCell(text, rightAlign, gainColor) {
    var td = document.createElement("td");
    td.textContent = text;
    if (rightAlign) td.className = "gains-num";
    if (gainColor != null) td.style.color = gainColor >= 0 ? "#16a34a" : "#dc2626";
    return td;
  }

  // -- Sub-tab bar --
  var subtabBar = document.createElement("div");
  subtabBar.className = "tools-subtabs";

  var realizedBtn = document.createElement("button");
  realizedBtn.className = "tools-subtab active";
  realizedBtn.textContent = "Realized & Donations";

  var unrealizedBtn = document.createElement("button");
  unrealizedBtn.className = "tools-subtab";
  unrealizedBtn.textContent = "Unrealized";

  subtabBar.appendChild(realizedBtn);
  subtabBar.appendChild(unrealizedBtn);
  container.appendChild(subtabBar);

  var realizedPanel = document.createElement("div");
  var unrealizedPanel = document.createElement("div");
  unrealizedPanel.className = "hidden";

  realizedBtn.addEventListener("click", function () {
    realizedBtn.classList.add("active");
    unrealizedBtn.classList.remove("active");
    realizedPanel.classList.remove("hidden");
    unrealizedPanel.classList.add("hidden");
  });
  unrealizedBtn.addEventListener("click", function () {
    unrealizedBtn.classList.add("active");
    realizedBtn.classList.remove("active");
    unrealizedPanel.classList.remove("hidden");
    realizedPanel.classList.add("hidden");
  });

  // -- Window selector header (Realized panel) --
  var wHeader = document.createElement("div");
  wHeader.className = "gains-window-header";
  var wLabel = document.createElement("span");
  wLabel.textContent = "Window:";
  var wSel = document.createElement("select");
  wSel.className = "analysis-window-select";
  var prevYearLabel = String(new Date().getFullYear() - 1);
  ["1M", "90D", "YTD", "PREV_YEAR", "1Y", "2Y", "All"].forEach(function (w) {
    var opt = document.createElement("option");
    opt.value = w;
    opt.textContent = w === "90D" ? "90 Days" : w === "1M" ? "1 Month" :
      w === "YTD" ? "YTD" : w === "PREV_YEAR" ? prevYearLabel :
      w === "1Y" ? "1 Year" : w === "2Y" ? "2 Years" : "All";
    if (w === GAINS_WINDOW) opt.selected = true;
    wSel.appendChild(opt);
  });
  wHeader.appendChild(wLabel);
  wHeader.appendChild(wSel);
  realizedPanel.appendChild(wHeader);

  var realizedContent = document.createElement("div");
  realizedPanel.appendChild(realizedContent);

  function renderRealizedSections(win) {
    realizedContent.innerHTML = "";

    // Compute cutoff / endDate
    var today = new Date().toISOString().slice(0, 10);
    var cutoff = null, endDate = null, winLabel = win;
    if (win === "YTD") {
      cutoff = today.slice(0, 4) + "-01-01";
    } else if (win === "PREV_YEAR") {
      cutoff = prevYearLabel + "-01-01";
      endDate = prevYearLabel + "-12-31";
      winLabel = prevYearLabel;
    } else if (win !== "All") {
      var dayMap = { "1M": 30, "90D": 90, "1Y": 365, "2Y": 730 };
      var rd = new Date(today);
      rd.setDate(rd.getDate() - (dayMap[win] || 365));
      cutoff = rd.toISOString().slice(0, 10);
    }

    function inWindow(entry) {
      if (cutoff && entry.date < cutoff) return false;
      if (endDate && entry.date > endDate) return false;
      return true;
    }

    var filteredRealized = realized.filter(inWindow);
    var filteredDonated = donated.filter(inWindow);

    // Summary table (computed from filtered realized)
    var stFiltered = 0, ltFiltered = 0;
    for (var fi = 0; fi < filteredRealized.length; fi++) {
      if (filteredRealized[fi].isLongTerm) ltFiltered += filteredRealized[fi].gain;
      else stFiltered += filteredRealized[fi].gain;
    }

    var summaryWrap = document.createElement("div");
    summaryWrap.className = "gains-summary";
    var sTable = document.createElement("table");
    sTable.className = "gains-summary-table";
    var sThead = document.createElement("thead");
    var sHr = document.createElement("tr");
    ["", "Short-Term", "Long-Term"].forEach(function (h) {
      var th = document.createElement("th");
      th.textContent = h;
      if (h !== "") th.className = "gains-num";
      sHr.appendChild(th);
    });
    sThead.appendChild(sHr);
    sTable.appendChild(sThead);
    var sTbody = document.createElement("tbody");
    var sRowStr = document.createElement("tr");
    var sRowLabel = document.createElement("td");
    sRowLabel.textContent = "Realized (" + winLabel + ")";
    sRowStr.appendChild(sRowLabel);
    sRowStr.appendChild(makeCell(fmtDollar(stFiltered), true, stFiltered));
    sRowStr.appendChild(makeCell(fmtDollar(ltFiltered), true, ltFiltered));
    sTbody.appendChild(sRowStr);
    sTable.appendChild(sTbody);
    summaryWrap.appendChild(sTable);
    realizedContent.appendChild(summaryWrap);

    // -- Realized gains table --
    var realizedSection = document.createElement("div");
    realizedSection.className = "gains-section";
    var realizedTitle = document.createElement("h3");
    realizedTitle.className = "gains-section-title";
    realizedTitle.textContent = "Realized Gains";
    realizedSection.appendChild(realizedTitle);

    if (filteredRealized.length === 0) {
      var emptyP = document.createElement("p");
      emptyP.className = "gains-empty";
      emptyP.textContent = "No realized gains recorded.";
      realizedSection.appendChild(emptyP);
    } else {
      var rTable = document.createElement("table");
      rTable.className = "gains-table";

      var rThead = document.createElement("thead");
      var rHr = document.createElement("tr");
      var rHeaders = ["Date Sold", "Symbol", "Shares", "Cost Basis", "Proceeds", "Gain / Loss", "Hold", "Type"];
      for (var rhi = 0; rhi < rHeaders.length; rhi++) {
        var rth = document.createElement("th");
        rth.textContent = rHeaders[rhi];
        if (rhi >= 2) rth.className = "gains-num";
        rHr.appendChild(rth);
      }
      rThead.appendChild(rHr);
      rTable.appendChild(rThead);

      // Sort by date descending
      var sortedRealized = filteredRealized.slice().sort(function (a, b) {
        return a.date > b.date ? -1 : a.date < b.date ? 1 : 0;
      });

      var rTbody = document.createElement("tbody");
      for (var ri = 0; ri < sortedRealized.length; ri++) {
        var r = sortedRealized[ri];
        var rtr = document.createElement("tr");
        rtr.appendChild(makeCell(fmtDateLong(r.date), false, null));
        rtr.appendChild(makeCell(r.symbol, false, null));
        if (r.warning) {
          var warnTd = document.createElement("td");
          warnTd.colSpan = 6;
          warnTd.className = "gains-warning";
          warnTd.textContent = "\u26a0 " + r.warning;
          rtr.appendChild(warnTd);
        } else {
          rtr.appendChild(makeCell(fmtShares(r.shares), true, null));
          rtr.appendChild(makeCell(fmtDollar(r.costBasis), true, null));
          rtr.appendChild(makeCell(fmtDollar(r.proceeds), true, null));
          var gainText = (r.gain >= 0 ? "+" : "") + fmtDollar(r.gain);
          rtr.appendChild(makeCell(gainText, true, r.gain));
          rtr.appendChild(makeCell(r.holdDays != null ? r.holdDays + "d" : "\u2014", true, null));
          rtr.appendChild(makeCell(r.isLongTerm === null ? "\u2014" : r.isLongTerm ? "Long" : "Short", true, null));
        }
        rTbody.appendChild(rtr);
      }
      rTable.appendChild(rTbody);
      realizedSection.appendChild(rTable);
    }
    realizedContent.appendChild(realizedSection);

    // -- Donations table --
    var donationsSection = document.createElement("div");
    donationsSection.className = "gains-section";
    var donationsTitle = document.createElement("h3");
    donationsTitle.className = "gains-section-title";
    donationsTitle.textContent = "Donations";
    donationsSection.appendChild(donationsTitle);

    if (filteredDonated.length === 0) {
      var donationsEmpty = document.createElement("p");
      donationsEmpty.className = "gains-empty";
      donationsEmpty.textContent = "No donations recorded.";
      donationsSection.appendChild(donationsEmpty);
    } else {
      var dTable = document.createElement("table");
      dTable.className = "gains-table";

      var dThead = document.createElement("thead");
      var dHr = document.createElement("tr");
      var dHeaders = ["Date Donated", "Symbol", "Shares", "Cost Basis", "FMV (Deduction)", "Forgone Gain", "Hold", "Type"];
      for (var dhi = 0; dhi < dHeaders.length; dhi++) {
        var dth = document.createElement("th");
        dth.textContent = dHeaders[dhi];
        if (dhi >= 2) dth.className = "gains-num";
        dHr.appendChild(dth);
      }
      dThead.appendChild(dHr);
      dTable.appendChild(dThead);

      var sortedDonated = filteredDonated.slice().sort(function (a, b) {
        return a.date > b.date ? -1 : a.date < b.date ? 1 : 0;
      });

      var dTbody = document.createElement("tbody");
      for (var di = 0; di < sortedDonated.length; di++) {
        var d = sortedDonated[di];
        var dtr = document.createElement("tr");
        dtr.appendChild(makeCell(fmtDateLong(d.date), false, null));
        dtr.appendChild(makeCell(d.symbol, false, null));
        dtr.appendChild(makeCell(fmtShares(d.shares), true, null));
        dtr.appendChild(makeCell(fmtDollar(d.costBasis), true, null));
        dtr.appendChild(makeCell(fmtDollar(d.fmvTotal), true, null));
        var dGainText = (d.gain >= 0 ? "+" : "") + fmtDollar(d.gain);
        dtr.appendChild(makeCell(dGainText, true, d.gain));
        dtr.appendChild(makeCell(d.holdDays != null ? d.holdDays + "d" : "\u2014", true, null));
        dtr.appendChild(makeCell(d.isLongTerm === null ? "\u2014" : d.isLongTerm ? "Long" : "Short", true, null));
        dTbody.appendChild(dtr);
      }
      dTable.appendChild(dTbody);
      donationsSection.appendChild(dTable);
    }
    realizedContent.appendChild(donationsSection);
  }

  renderRealizedSections(GAINS_WINDOW);

  wSel.addEventListener("change", function () {
    GAINS_WINDOW = wSel.value;
    renderRealizedSections(GAINS_WINDOW);
  });

  // -- Unrealized summary --
  var uSummaryWrap = document.createElement("div");
  uSummaryWrap.className = "gains-summary";
  var uSTable = document.createElement("table");
  uSTable.className = "gains-summary-table";
  var uSThead = document.createElement("thead");
  var uSHr = document.createElement("tr");
  ["", "Short-Term", "Long-Term"].forEach(function (h) {
    var th = document.createElement("th");
    th.textContent = h;
    if (h !== "") th.className = "gains-num";
    uSHr.appendChild(th);
  });
  uSThead.appendChild(uSHr);
  uSTable.appendChild(uSThead);
  var uSTbody = document.createElement("tbody");
  var uSRow = document.createElement("tr");
  var uSLabel = document.createElement("td");
  uSLabel.textContent = "Unrealized";
  uSRow.appendChild(uSLabel);
  uSRow.appendChild(makeCell(fmtDollar(summary.stUnrealized), true, summary.stUnrealized));
  uSRow.appendChild(makeCell(fmtDollar(summary.ltUnrealized), true, summary.ltUnrealized));
  uSTbody.appendChild(uSRow);
  uSTable.appendChild(uSTbody);
  uSummaryWrap.appendChild(uSTable);
  unrealizedPanel.appendChild(uSummaryWrap);

  // -- Unrealized gains table --
  var unrealizedSection = document.createElement("div");
  unrealizedSection.className = "gains-section";
  var unrealizedTitle = document.createElement("h3");
  unrealizedTitle.className = "gains-section-title";
  unrealizedTitle.textContent = "Unrealized Gains";
  unrealizedSection.appendChild(unrealizedTitle);

  if (unrealized.length === 0) {
    var emptyP2 = document.createElement("p");
    emptyP2.className = "gains-empty";
    emptyP2.textContent = "No open positions.";
    unrealizedSection.appendChild(emptyP2);
  } else {
    var uTable = document.createElement("table");
    uTable.className = "gains-table";

    var uThead = document.createElement("thead");
    var uHr = document.createElement("tr");
    var uHeaders = ["Symbol", "Shares", "Avg Cost", "Current Price", "Current Value", "Unrealized G/L", "Type"];
    for (var uhi = 0; uhi < uHeaders.length; uhi++) {
      var uth = document.createElement("th");
      uth.textContent = uHeaders[uhi];
      if (uhi >= 1) uth.className = "gains-num";
      uHr.appendChild(uth);
    }
    uThead.appendChild(uHr);
    uTable.appendChild(uThead);

    var uTbody = document.createElement("tbody");
    for (var ui = 0; ui < unrealized.length; ui++) {
      var u = unrealized[ui];
      var priceCell = u.currentPrice > 0 ? fmtDollar(u.currentPrice) : "\u2014";
      var typeText = u.isLongTerm === true ? "Long" : u.isLongTerm === false ? "Short" : "Mixed";
      var uGainText = (u.gain >= 0 ? "+" : "") + fmtDollar(u.gain);

      // Summary row (always one per symbol)
      var utr = document.createElement("tr");
      utr.setAttribute("data-symbol", u.symbol);

      var symTd = document.createElement("td");
      if (u.lotDetails && u.lotDetails.length > 0) {
        var btn = document.createElement("button");
        btn.className = "gains-expand-btn";
        btn.textContent = "+";
        symTd.appendChild(btn);
      }
      symTd.appendChild(document.createTextNode(u.symbol));
      utr.appendChild(symTd);
      utr.appendChild(makeCell(fmtShares(u.shares), true, null));
      utr.appendChild(makeCell(fmtDollar(u.avgCostBasis), true, null));
      utr.appendChild(makeCell(priceCell, true, null));
      utr.appendChild(makeCell(fmtDollar(u.currentValue), true, null));
      utr.appendChild(makeCell(uGainText, true, u.gain));
      utr.appendChild(makeCell(typeText, true, null));
      uTbody.appendChild(utr);

      // Lot detail rows (hidden by default)
      if (u.lotDetails && u.lotDetails.length > 0) {
        var lotRows = [];
        for (var li2 = 0; li2 < u.lotDetails.length; li2++) {
          var ld = u.lotDetails[li2];
          var lotTr = document.createElement("tr");
          lotTr.className = "gains-lot-row hidden";

          var dateTd = document.createElement("td");
          dateTd.className = "gains-lot-label";
          dateTd.textContent = ld.date;
          lotTr.appendChild(dateTd);

          var lotValue = ld.quantity * u.currentPrice;
          var lotGainText = (ld.gain >= 0 ? "+" : "") + fmtDollar(ld.gain);
          var holdText = ld.holdDays !== null
            ? ld.holdDays + "d \u00b7 " + (ld.isLongTerm ? "Long" : "Short")
            : "\u2014";

          lotTr.appendChild(makeCell(fmtShares(ld.quantity), true, null));
          lotTr.appendChild(makeCell(fmtDollar(ld.price), true, null));
          lotTr.appendChild(makeCell(u.currentPrice > 0 ? fmtDollar(u.currentPrice) : "\u2014", true, null));
          lotTr.appendChild(makeCell(u.currentPrice > 0 ? fmtDollar(lotValue) : "\u2014", true, null));
          lotTr.appendChild(makeCell(lotGainText, true, ld.gain));
          lotTr.appendChild(makeCell(holdText, true, null));

          uTbody.appendChild(lotTr);
          lotRows.push(lotTr);
        }

        // Attach click handler via closure
        (function (expandBtn, rows) {
          expandBtn.addEventListener("click", function () {
            var expanded = expandBtn.textContent === "\u2212";
            rows.forEach(function (r) { r.classList.toggle("hidden", expanded); });
            expandBtn.textContent = expanded ? "+" : "\u2212";
          });
        })(btn, lotRows);
      }
    }
    uTable.appendChild(uTbody);
    unrealizedSection.appendChild(uTable);
  }
  unrealizedPanel.appendChild(unrealizedSection);

  container.appendChild(realizedPanel);
  container.appendChild(unrealizedPanel);
}

// ---------------------------------------------------------------------------
// Trades editor
// ---------------------------------------------------------------------------

function buildTradesPanel(trades, marketTickers, onSave) {
  var container = document.getElementById("panel-trades");
  container.innerHTML = "";

  // Sort by date descending for display
  var rows = trades.slice().sort(function (a, b) {
    return a.date > b.date ? -1 : a.date < b.date ? 1 : 0;
  });

  // Controls bar
  var controls = document.createElement("div");
  controls.className = "trades-controls";

  var addBtn = document.createElement("button");
  addBtn.className = "trades-btn";
  addBtn.textContent = "Add Row";
  controls.appendChild(addBtn);

  var saveBtn = document.createElement("button");
  saveBtn.className = "trades-btn trades-btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.style.display = "none";
  controls.appendChild(saveBtn);

  var status = document.createElement("span");
  status.className = "trades-status";
  controls.appendChild(status);

  container.appendChild(controls);

  // Row list
  var list = document.createElement("div");
  list.id = "trades-list";
  container.appendChild(list);

  var currentExpanded = null; // rowDiv currently open

  function updateSaveBtn() {
    var dirty = list.querySelectorAll(".trade-row.trade-dirty");
    var invalid = list.querySelectorAll(".trade-row.trade-dirty.trade-invalid");
    saveBtn.style.display = dirty.length > 0 ? "" : "none";
    saveBtn.disabled = invalid.length > 0;
  }

  function validateRow(rowDiv) {
    // Returns array of invalid field names (name attribute values)
    var vals = readFieldValues(rowDiv);
    var bad = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(vals.date) || isNaN(Date.parse(vals.date))) bad.push("date");
    if (!vals.symbol.trim()) bad.push("symbol");
    var qty = parseFloat(vals.quantity);
    if (isNaN(qty) || qty <= 0) bad.push("quantity");
    var price = parseFloat(vals.price);
    if (isNaN(price) || price < 0) bad.push("price");
    if (vals.lotDate && (!/^\d{4}-\d{2}-\d{2}$/.test(vals.lotDate) || isNaN(Date.parse(vals.lotDate)))) bad.push("lot-date");
    return bad;
  }

  function formatSummary(vals) {
    var typeStr = vals.type || (parseFloat(vals.quantity || "0") < 0 ? "sell" : "buy");
    var typeLabel = typeStr.charAt(0).toUpperCase() + typeStr.slice(1);
    var qty = parseFloat(vals.quantity);
    var price = parseFloat(vals.price);
    var parts = [vals.date || "—", typeLabel, vals.symbol || "—"];
    if (!isNaN(qty) && qty !== 0) {
      parts.push(String(Math.abs(qty)));
      if (!isNaN(price) && price !== 0) {
        var total = Math.abs(qty) * price;
        parts.push("@ $" + price.toFixed(2) + " ($" + total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ")");
      }
    }
    var text = parts.join(" ");
    if (vals.lotDate) text += " \u00b7 lot " + vals.lotDate;
    return text;
  }

  function readFieldValues(rowDiv) {
    return {
      date: (rowDiv.querySelector('[name="date"]') || {}).value || "",
      symbol: (rowDiv.querySelector('[name="symbol"]') || {}).value || "",
      quantity: (rowDiv.querySelector('[name="quantity"]') || {}).value || "",
      price: (rowDiv.querySelector('[name="price"]') || {}).value || "",
      lotDate: (rowDiv.querySelector('[name="lot-date"]') || {}).value || "",
      note: (rowDiv.querySelector('[name="note"]') || {}).value || "",
      type: (rowDiv.querySelector('[name="type"]') || {}).value || "buy",
    };
  }

  function collapseRow(rowDiv) {
    if (!rowDiv) return;
    rowDiv.querySelector(".trade-detail").hidden = true;
    rowDiv.classList.remove("trade-expanded");
    if (currentExpanded === rowDiv) currentExpanded = null;
  }

  function expandRow(rowDiv) {
    if (currentExpanded && currentExpanded !== rowDiv) collapseRow(currentExpanded);
    rowDiv.querySelector(".trade-detail").hidden = false;
    rowDiv.classList.add("trade-expanded");
    currentExpanded = rowDiv;
    var dateInput = rowDiv.querySelector('[name="date"]');
    if (dateInput) dateInput.focus();
  }

  function makeRow(entry, isNew) {
    var rowDiv = document.createElement("div");
    rowDiv.className = "trade-row";

    // Infer type for initial render
    var inferredType = entry.type || (parseFloat(entry.quantity || "0") < 0 ? "sell" : "buy");
    if (inferredType === "donate") rowDiv.classList.add("trade-donate");

    // --- Summary ---
    var summaryDiv = document.createElement("div");
    summaryDiv.className = "trade-summary";

    var summarySpan = document.createElement("span");
    summarySpan.className = "trade-summary-text";
    var rawQtyNum = parseFloat(entry.quantity);
    var displayQty = isNaN(rawQtyNum) ? "" : String(Math.abs(rawQtyNum));
    summarySpan.textContent = formatSummary({
      date: entry.date || "",
      symbol: entry.symbol || "",
      quantity: displayQty,
      price: entry.price || "",
      lotDate: entry.lotDate || "",
      type: inferredType,
    });
    var invalidIndicator = document.createElement("span");
    invalidIndicator.className = "trade-invalid-indicator";
    invalidIndicator.title = "This row has missing or invalid fields";
    invalidIndicator.textContent = "\u26a0";
    summaryDiv.appendChild(summarySpan);
    summaryDiv.appendChild(invalidIndicator);
    summaryDiv.addEventListener("click", function () {
      if (currentExpanded === rowDiv) collapseRow(rowDiv);
      else expandRow(rowDiv);
    });
    rowDiv.appendChild(summaryDiv);

    // --- Detail ---
    var detailDiv = document.createElement("div");
    detailDiv.className = "trade-detail";
    detailDiv.hidden = true;

    // Fields grid
    var fieldsGrid = document.createElement("div");
    fieldsGrid.className = "trade-fields-grid";

    function makeField(labelText, widthClass, inputEl) {
      var fieldDiv = document.createElement("div");
      fieldDiv.className = "trade-field " + widthClass;
      var lbl = document.createElement("label");
      lbl.textContent = labelText;
      fieldDiv.appendChild(lbl);
      fieldDiv.appendChild(inputEl);
      return fieldDiv;
    }

    // Date
    var inputDate = document.createElement("input");
    inputDate.type = "text";
    inputDate.className = "trades-input";
    inputDate.name = "date";
    inputDate.value = entry.date || "";
    inputDate.placeholder = "YYYY-MM-DD";
    fieldsGrid.appendChild(makeField("Date", "trade-field-date", inputDate));

    // Symbol
    var symEl;
    if (marketTickers && marketTickers.length > 0) {
      symEl = document.createElement("select");
      symEl.className = "trades-input";
      symEl.name = "symbol";
      for (var ti = 0; ti < marketTickers.length; ti++) {
        var symOpt = document.createElement("option");
        symOpt.value = marketTickers[ti];
        symOpt.textContent = marketTickers[ti];
        symEl.appendChild(symOpt);
      }
      symEl.value = entry.symbol || marketTickers[0];
    } else {
      symEl = document.createElement("input");
      symEl.type = "text";
      symEl.className = "trades-input";
      symEl.name = "symbol";
      symEl.value = entry.symbol || "";
      symEl.placeholder = "e.g. VTI";
    }
    fieldsGrid.appendChild(makeField("Symbol", "trade-field-symbol", symEl));

    // Type
    var selectType = document.createElement("select");
    selectType.className = "trades-input";
    selectType.name = "type";
    var typeOptions = [["buy", "Buy"], ["sell", "Sell"], ["donate", "Donate"], ["drip", "Drip"]];
    for (var oi = 0; oi < typeOptions.length; oi++) {
      var typeOpt = document.createElement("option");
      typeOpt.value = typeOptions[oi][0];
      typeOpt.textContent = typeOptions[oi][1];
      selectType.appendChild(typeOpt);
    }
    selectType.value = inferredType;
    selectType.addEventListener("change", function () {
      if (selectType.value === "donate") rowDiv.classList.add("trade-donate");
      else rowDiv.classList.remove("trade-donate");
      lotDateFieldDiv.style.display = (selectType.value === "buy" || selectType.value === "drip") ? "none" : "";
    });
    fieldsGrid.appendChild(makeField("Type", "trade-field-type", selectType));

    // Quantity (displayed as absolute value)
    var inputQty = document.createElement("input");
    inputQty.type = "text";
    inputQty.className = "trades-input";
    inputQty.name = "quantity";
    inputQty.value = isNaN(rawQtyNum) ? "" : String(Math.abs(rawQtyNum));
    inputQty.placeholder = "0";
    fieldsGrid.appendChild(makeField("Qty", "trade-field-qty", inputQty));

    // Price
    var inputPrice = document.createElement("input");
    inputPrice.type = "text";
    inputPrice.className = "trades-input";
    inputPrice.name = "price";
    inputPrice.value = entry.price || "";
    inputPrice.placeholder = "0.00";
    fieldsGrid.appendChild(makeField("Price", "trade-field-price", inputPrice));

    // Lot Date (hidden for Buy trades)
    var inputLotDate = document.createElement("input");
    inputLotDate.type = "text";
    inputLotDate.className = "trades-input";
    inputLotDate.name = "lot-date";
    inputLotDate.value = entry.lotDate || "";
    inputLotDate.placeholder = "YYYY-MM-DD";
    var lotDateFieldDiv = makeField("Lot Date", "trade-field-lotdate", inputLotDate);
    lotDateFieldDiv.style.display = (inferredType === "buy" || inferredType === "drip") ? "none" : "";
    fieldsGrid.appendChild(lotDateFieldDiv);

    // Note (full-width)
    var inputNote = document.createElement("input");
    inputNote.type = "text";
    inputNote.className = "trades-input";
    inputNote.name = "note";
    inputNote.value = entry.note || "";
    inputNote.placeholder = "Note";
    fieldsGrid.appendChild(makeField("Note", "trade-field-note", inputNote));

    detailDiv.appendChild(fieldsGrid);

    // Declared here so updateState closes over the binding; assigned after
    // rowDiv.appendChild(detailDiv) so the inputs are actually queryable.
    var originalVals;

    function updateState() {
      var current = readFieldValues(rowDiv);
      var dirty = originalVals === null || !(
        current.date === originalVals.date && current.symbol === originalVals.symbol &&
        current.quantity === originalVals.quantity && current.price === originalVals.price &&
        current.lotDate === originalVals.lotDate && current.type === originalVals.type &&
        current.note === originalVals.note
      );
      rowDiv.classList.toggle("trade-dirty", dirty);

      var badFields = dirty ? validateRow(rowDiv) : [];
      rowDiv.classList.toggle("trade-invalid", badFields.length > 0);
      detailDiv.querySelectorAll(".trades-input").forEach(function (el) {
        el.classList.toggle("trades-input-invalid", badFields.indexOf(el.name) >= 0);
      });

      summarySpan.textContent = formatSummary(current);
      updateSaveBtn();
    }

    rowDiv._update = updateState;
    detailDiv.addEventListener("input", updateState);

    // Footer with delete button
    var footer = document.createElement("div");
    footer.className = "trade-detail-footer";

    var delBtn = document.createElement("button");
    delBtn.className = "trades-btn trades-btn-danger trades-btn-del";
    delBtn.textContent = "\u{1F5D1}";
    delBtn.title = "Delete row";
    delBtn.addEventListener("click", function () {
      if (delBtn.dataset.confirm === "1") {
        if (currentExpanded === rowDiv) currentExpanded = null;
        rowDiv.remove();
        updateSaveBtn();
      } else {
        delBtn.dataset.confirm = "1";
        delBtn.title = "Click again to confirm deletion";
        delBtn.classList.add("trades-btn-del-confirm");
        setTimeout(function () {
          delBtn.dataset.confirm = "";
          delBtn.title = "Delete row";
          delBtn.classList.remove("trades-btn-del-confirm");
        }, 2500);
      }
    });
    footer.appendChild(delBtn);
    detailDiv.appendChild(footer);

    rowDiv.appendChild(detailDiv);
    // Snapshot after inputs are in the DOM so querySelector works correctly
    originalVals = isNew ? null : readFieldValues(rowDiv);
    return rowDiv;
  }

  for (var j = 0; j < rows.length; j++) {
    list.appendChild(makeRow(rows[j]));
  }

  // Add row
  addBtn.addEventListener("click", function () {
    var today = localDateString();
    var defaultSym = marketTickers && marketTickers.length > 0 ? marketTickers[0] : "";
    var newRow = makeRow({ date: today, symbol: defaultSym, price: "", quantity: "", type: "buy" }, true);
    list.insertBefore(newRow, list.firstChild);
    newRow._update(); // run initial validation + show Save
    expandRow(newRow);
  });

  // Save
  saveBtn.addEventListener("click", function () {
    if (currentExpanded) collapseRow(currentExpanded);
    var rowDivs = list.querySelectorAll(".trade-row");
    var data = [];
    for (var r = 0; r < rowDivs.length; r++) {
      var rd = rowDivs[r];
      var vals = readFieldValues(rd);
      data.push({
        date: vals.date.trim(),
        symbol: vals.symbol.trim(),
        price: vals.price.trim(),
        quantity: vals.quantity.trim(),
        lotDate: vals.lotDate.trim(),
        note: vals.note.trim(),
        type: vals.type || "buy",
      });
    }

    status.textContent = "Saving...";
    status.style.color = "#666";
    saveBtn.disabled = true;

    fetch("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(function (res) { return res.json(); })
      .then(function (result) {
        saveBtn.disabled = false;
        if (result.error) {
          status.textContent = result.error;
          status.style.color = "#dc2626";
        } else {
          status.textContent = "Saved (" + result.rows + " rows)";
          status.style.color = "#16a34a";
          list.querySelectorAll(".trade-row").forEach(function (r) { r.classList.remove("trade-dirty"); });
          updateSaveBtn();
          if (onSave) onSave();
        }
      })
      .catch(function (err) {
        saveBtn.disabled = false;
        status.textContent = "Error: " + err.message;
        status.style.color = "#dc2626";
      });
  });
}


// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async function () {
  await loadConfig();
  var trades, market, retirement, assets;
  try {
    var results = await Promise.all([
      fetchJSON("data/trades.json"),
      fetchJSON("data/market.json"),
      fetchJSON("data/retirement.json").catch(function () { return null; }),
      fetchJSON("data/assets.json").catch(function () { return null; }),
    ]);
    trades = results[0];
    market = results[1];
    retirement = results[2];
    assets = results[3];
  } catch (err) {
    document.body.classList.remove("loading");
    document.getElementById("app").textContent =
      "Error loading data: " + err.message;
    return;
  }

  var fullData = processData(trades, market);
  if (!fullData) {
    fullData = { symbols: [], chartData: [], yMax: 1 };
  }
  mergeRetirement(fullData, retirement, market);
  mergeAssets(fullData, assets, market);
  applySymbolOrder(fullData, SYMBOL_ORDER);
  var gainsData = computeGains(trades || [], market || [], GAINS_METHOD);
  if (fullData.chartData.length < 2) {
    document.body.classList.remove("loading");
    document.getElementById("app").textContent = "Not enough data to display.";
    return;
  }

  var select = document.getElementById("time-window");
  var prevYearOpt = document.getElementById("prev-year-option");
  if (prevYearOpt) prevYearOpt.textContent = String(new Date().getFullYear() - 1);
  var state = { data: filterData(fullData, select.value) };

  var canvas = document.getElementById("chart");
  var wrap = document.getElementById("chart-wrap");

  // chartRef is mutated on resize; listeners read from it directly.
  var chartRef = setupCanvas(canvas, wrap);

  function updateTitle() {
    document.getElementById("tab-chart-btn").textContent = "Overview";
  }

  // Tab switching
  var tabs = document.querySelectorAll("#tabs .tab");
  var panelNames = ["chart", "exposure", "table", "gains", "trades", "tools"];
  for (var ti = 0; ti < tabs.length; ti++) {
    tabs[ti].addEventListener("click", function () {
      var target = this.getAttribute("data-tab");
      for (var tj = 0; tj < tabs.length; tj++) {
        tabs[tj].classList.toggle("active", tabs[tj] === this);
      }
      for (var pi = 0; pi < panelNames.length; pi++) {
        document.getElementById("panel-" + panelNames[pi]).classList.toggle(
          "hidden",
          panelNames[pi] !== target,
        );
      }
      if (target === "chart") resizeChart();
      fetch("/api/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tab: target }),
      }).catch(function () {});
    });
  }

  function rebuildAll() {
    Promise.all([
      fetchJSON("data/trades.json"),
      fetchJSON("data/market.json"),
      fetchJSON("data/retirement.json").catch(function () { return null; }),
      fetchJSON("data/assets.json").catch(function () { return null; }),
    ])
      .then(function (results) {
        trades = results[0];
        market = results[1];
        retirement = results[2];
        assets = results[3];
        fullData = processData(trades, market);
        if (!fullData) fullData = { symbols: [], chartData: [], yMax: 1 };
        mergeRetirement(fullData, retirement, market);
        mergeAssets(fullData, assets, market);
        applySymbolOrder(fullData, SYMBOL_ORDER);
        gainsData = computeGains(trades || [], market || [], GAINS_METHOD);
        if (fullData.chartData.length < 2) return;
        state.data = filterData(fullData, select.value);
        drawChart(chartRef, state.data, null);
        updateTitle();
        updateDetail(state.data, state.data.chartData.length - 1);
        document.getElementById("panel-table").innerHTML = "";
        buildHistoryTable(fullData, retirement, rebuildAll);
        document.getElementById("panel-exposure").innerHTML = "";
        buildExposurePanel(fullData, trades, retirement, assets);
        var tickers = market.length > 0
          ? Object.keys(market[0]).filter(function (k) { return k !== "timestamp"; })
          : [];
        buildTradesPanel(trades, tickers, rebuildAll);
        buildGainsPanel(gainsData);
        buildToolsPanel(fullData, EXPOSURE_MAP, REBALANCING_CONFIG);
      });
  }

  var marketTickers = market.length > 0
    ? Object.keys(market[0]).filter(function (k) { return k !== "timestamp"; })
    : [];

  if (market.length > 0) {
    var lastTs = market[market.length - 1].timestamp; // "YYYY-MM-DD HH:MM"
    var tsParts = lastTs.split(" ");
    var dateParts = tsParts[0].split("-");
    var timeParts = (tsParts[1] || "").split(":");
    var h = parseInt(timeParts[0], 10);
    var m = timeParts[1] || "00";
    var ampm = h >= 12 ? "PM" : "AM";
    var h12 = h % 12 || 12;
    var fetchedLabel = MONTHS[parseInt(dateParts[1], 10) - 1] + " " +
      parseInt(dateParts[2], 10) + ", " + h12 + ":" + m + "\u202f" + ampm + " ET";
    document.getElementById("detail-fetched").textContent = "Fetched " + fetchedLabel;
  }

  drawChart(chartRef, state.data, null);
  updateTitle();
  updateDetail(state.data, state.data.chartData.length - 1);
  buildHistoryTable(fullData, retirement, rebuildAll);
  buildExposurePanel(fullData, trades, retirement, assets);
  buildTradesPanel(trades, marketTickers, rebuildAll);
  buildGainsPanel(gainsData);
  buildToolsPanel(fullData, EXPOSURE_MAP, REBALANCING_CONFIG);
  attachListeners(canvas, state, chartRef);
  document.body.classList.remove("loading");

  document.getElementById("detail-expand").addEventListener("click", function () {
    document.getElementById("detail").classList.toggle("detail-expanded");
  });

  select.addEventListener("change", function () {
    state.data = filterData(fullData, select.value);
    drawChart(chartRef, state.data, null);
    updateTitle();
    updateDetail(state.data, state.data.chartData.length - 1);
  });

  function resizeChart() {
    if (wrap.clientWidth === 0) return;
    var fresh = setupCanvas(canvas, wrap);
    chartRef.ctx = fresh.ctx;
    chartRef.w = fresh.w;
    chartRef.h = fresh.h;
    drawChart(chartRef, state.data, null);
    updateDetail(state.data, state.data.chartData.length - 1);
  }

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeChart, 150);
  });
});
