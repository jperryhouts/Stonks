(function (exports) {
  "use strict";

  var niceMax = exports.niceMax = function niceMax(v) {
    if (!Number.isFinite(v) || v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var steps = [1, 1.25, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10];
    for (var i = 0; i < steps.length; i++) {
      var candidate = steps[i] * mag;
      if (candidate >= v) return candidate;
    }
    return 10 * mag;
  };

  /**
   * Rebuild cumulative arrays and totals for all symbols, then recompute yMax.
   * Mutates data in place.
   */
  exports.rebuildCumulatives = function rebuildCumulatives(data) {
    var chartData = data.chartData;
    var symbols = data.symbols;
    var liabilities = data.liabilitySymbols || [];
    var hasLiabilities = liabilities.length > 0;

    // Build a lookup set for liability symbols
    var isLiability = {};
    if (hasLiabilities) {
      for (var li = 0; li < liabilities.length; li++) {
        isLiability[liabilities[li]] = true;
      }
    }

    for (var i = 0; i < chartData.length; i++) {
      var cd = chartData[i];
      cd.cumulative = [];

      if (hasLiabilities) {
        // Compute gross total (assets only) and liability total
        var grossTotal = 0;
        var liabilityTotal = 0;
        for (var si = 0; si < symbols.length; si++) {
          var v = cd.values[symbols[si]] || 0;
          if (isLiability[symbols[si]]) {
            liabilityTotal += v; // negative
          } else {
            grossTotal += v;
          }
        }
        var netTotal = grossTotal + liabilityTotal;
        var ratio = grossTotal > 0 ? netTotal / grossTotal : 1;

        var running = 0;
        for (var si2 = 0; si2 < symbols.length; si2++) {
          if (isLiability[symbols[si2]]) {
            // Zero-width band: keep same cumulative as previous
            cd.cumulative.push(running);
          } else {
            running += (cd.values[symbols[si2]] || 0) * ratio;
            cd.cumulative.push(running);
          }
        }
        cd.total = netTotal;
      } else {
        var running2 = 0;
        for (var si3 = 0; si3 < symbols.length; si3++) {
          running2 += cd.values[symbols[si3]] || 0;
          cd.cumulative.push(running2);
        }
        cd.total = running2;
      }
    }
    var rawMax = 0;
    for (var yi = 0; yi < chartData.length; yi++) {
      if (chartData[yi].total > rawMax) rawMax = chartData[yi].total;
    }
    data.yMax = niceMax(rawMax);
  };

  exports.processData = function processData(trades, market) {
    // 1. Build cumulative positions from trades (sorted by date)
    trades.sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });

    var symbolSet = {};
    var symbols = [];
    var snapshots = [];
    var running = {};

    for (var i = 0; i < trades.length; i++) {
      var h = trades[i];
      var sym = h.symbol;
      var qty = parseFloat(h.quantity);
      if (h.type === "buy" || h.type === "drip") qty = Math.abs(qty);
      else if (h.type === "sell" || h.type === "donate") qty = -Math.abs(qty);
      if (!symbolSet[sym]) {
        symbolSet[sym] = true;
        symbols.push(sym);
      }
      running[sym] = Math.max(0, (running[sym] || 0) + qty);
      var posCopy = {};
      for (var s in running) posCopy[s] = running[s];
      snapshots.push({ date: h.date, positions: posCopy });
    }

    var firstDate = snapshots.length > 0 ? snapshots[0].date : null;
    if (!firstDate) return null;

    // 2. Walk market days, compute values
    var chartData = [];
    var snapIdx = 0;
    var currentPos = {};

    for (var j = 0; j < market.length; j++) {
      var row = market[j];
      var date = row.timestamp.slice(0, 10);

      if (date < firstDate) continue;

      while (snapIdx < snapshots.length && snapshots[snapIdx].date <= date) {
        currentPos = snapshots[snapIdx].positions;
        snapIdx++;
      }

      var values = {};
      var cumulative = [];
      var runningTotal = 0;

      for (var k = 0; k < symbols.length; k++) {
        var s2 = symbols[k];
        var shares = currentPos[s2] || 0;
        var price = parseFloat(row[s2]) || 0;
        var val = shares * price;
        values[s2] = val;
        runningTotal += val;
        cumulative.push(runningTotal);
      }

      chartData.push({
        date: date,
        prices: row,
        positions: currentPos,
        values: values,
        cumulative: cumulative,
        total: runningTotal,
      });
    }

    // 3. Compute Y-axis max
    var rawMax = 0;
    for (var m = 0; m < chartData.length; m++) {
      var t = chartData[m].total;
      if (t > rawMax) rawMax = t;
    }

    return { symbols: symbols, chartData: chartData, yMax: niceMax(rawMax) };
  };

  exports.filterData = function filterData(fullData, windowKey) {
    if (windowKey === "All") return fullData;

    var cd = fullData.chartData;
    if (cd.length === 0) return fullData;

    var last = cd[cd.length - 1].date;
    var cutoff;

    var endDate = null;
    if (windowKey === "YTD") {
      cutoff = last.slice(0, 4) + "-01-01";
    } else if (windowKey === "PREV_YEAR") {
      var prevYear = String(parseInt(last.slice(0, 4), 10) - 1);
      cutoff = prevYear + "-01-01";
      endDate = prevYear + "-12-31";
    } else {
      var dayMap = { "1M": 30, "90D": 90, "1Y": 365, "2Y": 730 };
      var d = new Date(last);
      d.setDate(d.getDate() - (dayMap[windowKey] || 0));
      cutoff = d.toISOString().slice(0, 10);
    }

    var filtered = [];
    for (var i = 0; i < cd.length; i++) {
      if (cd[i].date >= cutoff && (!endDate || cd[i].date <= endDate)) filtered.push(cd[i]);
    }
    if (filtered.length < 2) return fullData;

    var rawMax = 0;
    for (var j = 0; j < filtered.length; j++) {
      if (filtered[j].total > rawMax) rawMax = filtered[j].total;
    }

    return {
      symbols: fullData.symbols,
      liabilitySymbols: fullData.liabilitySymbols,
      chartData: filtered,
      yMax: niceMax(rawMax),
    };
  };

  exports.applySymbolOrder = function applySymbolOrder(fullData, symbolOrder) {
    if (!symbolOrder || !symbolOrder.length) return;
    var syms = fullData.symbols;
    var inOrder = symbolOrder.filter(function (s) {
      return syms.indexOf(s) !== -1;
    });
    var rest = syms.filter(function (s) {
      return symbolOrder.indexOf(s) === -1;
    });
    fullData.symbols = rest.concat(inOrder);
    exports.rebuildCumulatives(fullData);
  };

})(typeof module !== "undefined" && module.exports
  ? module.exports
  : (window.Portfolio = window.Portfolio || {}));
