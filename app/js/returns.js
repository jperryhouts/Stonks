(function (exports) {
  "use strict";

  /**
   * Compute annualized TWR and XIRR for a given time window.
   *
   * @param {Array}  chartData   - [{date, total, ...}] from processData/mergeRetirement/mergeAssets
   * @param {Array}  trades      - [{date, symbol, price, quantity, type?}] (strings)
   * @param {string} windowStart - "YYYY-MM-DD" inclusive
   * @param {string} windowEnd   - "YYYY-MM-DD" inclusive
   * @returns {{ twr: number|null, xirr: number|null }}
   *   Both are annualized decimal rates (0.12 = 12%). null = insufficient data.
   */
  function computeReturns(chartData, trades, windowStart, windowEnd) {
    // Slice chartData to window
    var slice = [];
    for (var i = 0; i < chartData.length; i++) {
      var d = chartData[i].date;
      if (d >= windowStart && d <= windowEnd) slice.push(chartData[i]);
    }
    if (slice.length < 2) return { twr: null, xirr: null };

    var days = Math.round(
      (new Date(slice[slice.length - 1].date) - new Date(slice[0].date)) / 86400000
    );
    if (days < 1) return { twr: null, xirr: null };

    // Build a sorted list of chart dates for trade-date alignment
    var chartDatesSorted = [];
    for (var ci = 0; ci < slice.length; ci++) {
      chartDatesSorted.push(slice[ci].date);
    }

    // Build net cash flow map: mapped to the first chart date >= trade date.
    // This matches processData behaviour: trades appear in chartData on their date
    // (or the next trading day if traded on a weekend/holiday).
    var cfMap = {};
    for (var ti = 0; ti < trades.length; ti++) {
      var tx = trades[ti];
      if (tx.date < windowStart || tx.date > windowEnd) continue;
      var qty = parseFloat(tx.quantity);
      var price = parseFloat(tx.price);
      if (isNaN(qty) || isNaN(price)) continue;
      // Drip (dividend reinvestment) is organic portfolio income, not external capital
      if (tx.type === "drip") continue;
      if (tx.type === "buy") qty = Math.abs(qty);
      else if (tx.type === "sell" || tx.type === "donate") qty = -Math.abs(qty);
      // Find first chart date >= trade date
      var mappedDate = null;
      for (var ci2 = 0; ci2 < chartDatesSorted.length; ci2++) {
        if (chartDatesSorted[ci2] >= tx.date) { mappedDate = chartDatesSorted[ci2]; break; }
      }
      if (!mappedDate) continue;
      cfMap[mappedDate] = (cfMap[mappedDate] || 0) + qty * price;
    }

    // -------------------------------------------------------------------
    // TWR — chain daily holding-period returns, stripping cash flows
    // -------------------------------------------------------------------
    var twr = null;
    var chainProduct = 1;
    var prevTotal = slice[0].total;

    if (prevTotal > 0) {
      for (var si = 1; si < slice.length; si++) {
        var entry = slice[si];
        var cf = cfMap[entry.date] || 0;
        if (prevTotal <= 0) { prevTotal = entry.total; continue; }
        var hpr = (entry.total - cf) / prevTotal - 1;
        chainProduct *= (1 + hpr);
        prevTotal = entry.total;
      }
      var totalReturn = chainProduct - 1;
      twr = Math.pow(1 + totalReturn, 365 / days) - 1;
    }

    // -------------------------------------------------------------------
    // XIRR — cash flows: initial portfolio (outflow), trades, final value (inflow)
    // -------------------------------------------------------------------
    var xirr = null;
    var startVal = slice[0].total;
    var endVal = slice[slice.length - 1].total;

    if (startVal > 0 || endVal > 0) {
      var t0 = new Date(slice[0].date).getTime();
      var cfs = [];

      if (startVal > 0) {
        cfs.push({ amount: -startVal, t: t0 });
      }

      for (var ti2 = 0; ti2 < trades.length; ti2++) {
        var tx2 = trades[ti2];
        if (tx2.date < windowStart || tx2.date > windowEnd) continue;
        var qty2 = parseFloat(tx2.quantity);
        var price2 = parseFloat(tx2.price);
        if (isNaN(qty2) || isNaN(price2)) continue;
        // Donations and drip reinvestments are not investor cash flows — skip for XIRR
        if (tx2.type === "donate" || tx2.type === "drip") continue;
        if (tx2.type === "buy") qty2 = Math.abs(qty2);
        else if (tx2.type === "sell") qty2 = -Math.abs(qty2);
        // buy (qty2 > 0): investor pays out → negative CF
        // sell (qty2 < 0): investor receives → positive CF
        var tradeAmt = qty2 > 0 ? -(qty2 * price2) : Math.abs(qty2) * price2;
        cfs.push({ amount: tradeAmt, t: new Date(tx2.date).getTime() });
      }

      cfs.push({ amount: endVal, t: new Date(slice[slice.length - 1].date).getTime() });

      xirr = _xirr(cfs);
    }

    return { twr: twr, xirr: xirr };
  }

  /**
   * Newton-Raphson XIRR solver.
   * @param {Array} cfs - [{amount, t}] where t is ms timestamp
   * @returns {number|null} annualized rate, or null if no convergence
   */
  function _xirr(cfs) {
    if (cfs.length < 2) return null;

    var t0 = cfs[0].t;
    var MS_PER_YEAR = 365 * 86400000;

    function npv(r) {
      var sum = 0;
      for (var i = 0; i < cfs.length; i++) {
        var t = (cfs[i].t - t0) / MS_PER_YEAR;
        sum += cfs[i].amount / Math.pow(1 + r, t);
      }
      return sum;
    }

    function dnpv(r) {
      var sum = 0;
      for (var i = 0; i < cfs.length; i++) {
        var t = (cfs[i].t - t0) / MS_PER_YEAR;
        if (t === 0) continue;
        sum -= t * cfs[i].amount / Math.pow(1 + r, t + 1);
      }
      return sum;
    }

    var r = 0.1;
    for (var iter = 0; iter < 200; iter++) {
      var f = npv(r);
      var df = dnpv(r);
      if (Math.abs(df) < 1e-12) break;
      var nr = r - f / df;
      if (nr < -0.999) nr = -0.5;
      if (Math.abs(nr - r) < 1e-8) return nr;
      r = nr;
    }
    return null;
  }

  exports.computeReturns = computeReturns;
})(typeof module !== "undefined" && module.exports
  ? module.exports
  : (window.Portfolio = window.Portfolio || {}));
