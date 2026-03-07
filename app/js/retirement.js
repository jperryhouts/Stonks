(function (exports) {
  "use strict";

  var rebuildCumulatives = (typeof Portfolio !== "undefined")
    ? Portfolio.rebuildCumulatives
    : require("./data.js").rebuildCumulatives;

  /**
   * Append retirement/manual accounts to chart data by interpolating daily values
   * from periodic ground truth entries using a proxy ticker.
   * Mutates data in place.
   */
  exports.mergeRetirement = function mergeRetirement(data, retirement, market) {
    if (!retirement || !Array.isArray(retirement.accounts) || retirement.accounts.length === 0) return;
    if (!Array.isArray(retirement.values)) return;

    var chartData = data.chartData;
    var symbols = data.symbols;

    // If processData returned null (no trades), build skeleton chartData
    if (chartData.length === 0 && market && market.length > 0) {
      var earliest = null;
      for (var ei = 0; ei < retirement.values.length; ei++) {
        var d = retirement.values[ei].date;
        if (!earliest || d < earliest) earliest = d;
      }
      if (!earliest) return;
      for (var mi = 0; mi < market.length; mi++) {
        var mDate = market[mi].timestamp.slice(0, 10);
        if (mDate < earliest) continue;
        chartData.push({
          date: mDate,
          prices: market[mi],
          positions: {},
          values: {},
          cumulative: [],
          total: 0,
        });
      }
    }

    if (chartData.length === 0) return;

    for (var ai = 0; ai < retirement.accounts.length; ai++) {
      var acct = retirement.accounts[ai];
      var name = acct.name;
      var proxy = acct.proxy || "VTI";
      if (symbols.indexOf(name) === -1) symbols.push(name);

      // Gather and sort this account's ground truth values
      var gts = [];
      for (var vi = 0; vi < retirement.values.length; vi++) {
        var v = retirement.values[vi];
        if (v.account === name) {
          gts.push({ date: v.date, value: parseFloat(v.value) });
        }
      }
      gts.sort(function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      });

      // Gather and sort this account's contributions
      var contribs = [];
      if (retirement.contributions) {
        for (var cni = 0; cni < retirement.contributions.length; cni++) {
          var c = retirement.contributions[cni];
          if (c.account === name) {
            contribs.push({ date: c.date, amount: parseFloat(String(c.amount).replace(/,/g, "")) || 0 });
          }
        }
        contribs.sort(function (a, b) {
          return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
        });
      }

      // Walk chartData, advancing ground truth and contribution pointers
      var gtIdx = 0;
      var contrIdx = 0;
      var activeVal = 0;
      var basePrice = 0;
      var lastGtDate = null;

      for (var ci = 0; ci < chartData.length; ci++) {
        var cd = chartData[ci];
        var proxyPrice = parseFloat(cd.prices[proxy]) || 0;

        // Advance to latest ground truth on or before this date
        while (gtIdx < gts.length && gts[gtIdx].date <= cd.date) {
          activeVal = gts[gtIdx].value;
          basePrice = proxyPrice;
          lastGtDate = gts[gtIdx].date;
          gtIdx++;
        }

        // Skip contributions already covered by the most recent GT
        // (their value is already included in the GT balance)
        if (lastGtDate !== null) {
          while (contrIdx < contribs.length && contribs[contrIdx].date <= lastGtDate) {
            contrIdx++;
          }
        }

        // Apply contributions that have arrived by today (and aren't covered by a GT)
        while (contrIdx < contribs.length && contribs[contrIdx].date <= cd.date) {
          if (activeVal > 0) {
            // Scale current base value to today's proxy price, then add contribution
            var scaledVal = (basePrice > 0 && proxyPrice > 0)
              ? activeVal * (proxyPrice / basePrice)
              : activeVal;
            activeVal = scaledVal + contribs[contrIdx].amount;
            basePrice = proxyPrice;
          }
          contrIdx++;
        }

        // Compute interpolated value; fall back to raw GT value when proxy unavailable
        var acctValue = 0;
        if (activeVal > 0) {
          if (basePrice > 0 && proxyPrice > 0) {
            acctValue = activeVal * (proxyPrice / basePrice);
          } else {
            acctValue = activeVal;
          }
        }
        cd.values[name] = acctValue;
      }
    }

    rebuildCumulatives(data);
  };

})(typeof module !== "undefined" && module.exports
  ? module.exports
  : (window.Portfolio = window.Portfolio || {}));
