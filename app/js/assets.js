(function (exports) {
  "use strict";

  var rebuildCumulatives = (typeof Portfolio !== "undefined")
    ? Portfolio.rebuildCumulatives
    : require("./data.js").rebuildCumulatives;

  function monthsBetween(d1, d2) {
    return (d2.getFullYear() - d1.getFullYear()) * 12
         + (d2.getMonth() - d1.getMonth());
  }

  exports.computeMortgageEquity = function computeMortgageEquity(asset, dateStr) {
    var purchaseDate = new Date(asset.purchaseDate + "T00:00:00");
    var currentDate = new Date(dateStr + "T00:00:00");
    if (currentDate < purchaseDate) return 0;

    var homeValue = parseFloat(asset.homeValue);
    var downPayment = parseFloat(asset.downPayment);
    var loanAmount = homeValue - downPayment;
    var annualRate = parseFloat(asset.annualRate);
    var termMonths = parseFloat(asset.loanTermYears) * 12;
    var extraPayments = asset.extraPayments || [];

    if (loanAmount <= 0) return homeValue;

    var monthsElapsed = monthsBetween(purchaseDate, currentDate);
    if (monthsElapsed <= 0) return downPayment;

    var paymentsMade = Math.min(monthsElapsed, termMonths);

    // Fast path: no extra payments — use closed-form formula
    if (extraPayments.length === 0) {
      if (annualRate <= 0) {
        var remaining = loanAmount * (1 - paymentsMade / termMonths);
        return homeValue - Math.max(remaining, 0);
      }
      var r = annualRate / 12;
      var payment = loanAmount * (r * Math.pow(1 + r, termMonths))
                    / (Math.pow(1 + r, termMonths) - 1);
      var factor = Math.pow(1 + r, paymentsMade);
      var remainingBalance = loanAmount * factor - payment * (factor - 1) / r;
      return homeValue - Math.max(remainingBalance, 0);
    }

    // Month-by-month simulation when extra payments are present
    var r2 = annualRate / 12;
    var payment2 = annualRate > 0
      ? loanAmount * (r2 * Math.pow(1 + r2, termMonths)) / (Math.pow(1 + r2, termMonths) - 1)
      : loanAmount / termMonths;
    var balance = loanAmount;

    for (var m = 1; m <= paymentsMade && balance > 0; m++) {
      if (annualRate > 0) {
        var interest = balance * r2;
        balance -= Math.min(payment2 - interest, balance);
      } else {
        balance -= Math.min(payment2, balance);
      }
      // Apply extra payments whose date falls in this payment month window:
      // [purchaseDate + (m-1) months, purchaseDate + m months)
      var winStart = new Date(purchaseDate);
      winStart.setMonth(winStart.getMonth() + (m - 1));
      var winEnd = new Date(purchaseDate);
      winEnd.setMonth(winEnd.getMonth() + m);
      for (var ep = 0; ep < extraPayments.length; ep++) {
        var epDate = new Date(extraPayments[ep].date + "T00:00:00");
        if (epDate >= winStart && epDate < winEnd) {
          balance = Math.max(0, balance - parseFloat(extraPayments[ep].amount));
        }
      }
    }

    return homeValue - Math.max(balance, 0);
  };

  exports.computeIBondValue = function computeIBondValue(asset, dateStr) {
    var purchaseDate = new Date(asset.purchaseDate + "T00:00:00");
    var currentDate = new Date(dateStr + "T00:00:00");
    if (currentDate < purchaseDate) return 0;

    // Treasury computes on a $25 base unit, rounded to the nearest penny.
    // The rounded value carries forward as the basis for the next period.
    var numUnits = parseFloat(asset.purchaseValue) / 25;
    var unitValue = 25.00;
    var fixedRate = parseFloat(asset.fixedRate || 0);
    var rates = (asset.rates || []).slice().sort(function (a, b) {
      return a.setDate < b.setDate ? -1 : a.setDate > b.setDate ? 1 : 0;
    });

    var periodStart = new Date(purchaseDate);
    while (true) {
      var periodEnd = new Date(periodStart);
      periodEnd.setMonth(periodEnd.getMonth() + 6);

      // Find the applicable semiannual inflation rate: most recent entry on or before periodStart
      var isoStart = periodStart.getFullYear() + "-"
        + String(periodStart.getMonth() + 1).padStart(2, "0") + "-"
        + String(periodStart.getDate()).padStart(2, "0");
      var semiannualInflation = 0;
      for (var ri = 0; ri < rates.length; ri++) {
        if (rates[ri].setDate <= isoStart) semiannualInflation = parseFloat(rates[ri].semiannualInflation);
      }

      // Composite rate formula: fixed + 2*semi + fixed*semi (floored at 0 per Treasury rules)
      var composite = fixedRate + (2 * semiannualInflation) + (fixedRate * semiannualInflation);
      if (composite < 0) composite = 0;
      var semiannualGrowth = 1 + composite / 2;

      if (periodEnd > currentDate) {
        // Partial period: monthly accrual via pseudo-monthly compounding
        // Value = base × (1 + composite/2)^(m/6), rounded to penny on $25 unit
        var months = monthsBetween(periodStart, currentDate);
        if (months > 0) {
          unitValue = Math.round(unitValue * Math.pow(semiannualGrowth, months / 6) * 100) / 100;
        }
        break;
      }

      // Complete 6-month period: compound and round to penny on $25 base
      unitValue = Math.round(unitValue * semiannualGrowth * 100) / 100;
      periodStart = periodEnd;
    }
    return numUnits * unitValue;
  };

  exports.mergeAssets = function mergeAssets(data, assets, market) {
    if (!Array.isArray(assets) || assets.length === 0) return;

    var chartData = data.chartData;
    var symbols = data.symbols;

    // If chartData is empty (no trades, no retirement), build skeleton from market
    if (chartData.length === 0 && market && market.length > 0) {
      var earliest = null;
      for (var ai = 0; ai < assets.length; ai++) {
        var d = assets[ai].purchaseDate;
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

    var computeMortgageEquity = exports.computeMortgageEquity;
    var computeIBondValue = exports.computeIBondValue;

    for (var ai = 0; ai < assets.length; ai++) {
      var asset = assets[ai];
      var name = asset.name;
      symbols.push(name);

      for (var ci = 0; ci < chartData.length; ci++) {
        var cd = chartData[ci];
        var val = 0;
        if (asset.type === "mortgage") {
          val = computeMortgageEquity(asset, cd.date);
        } else if (asset.type === "ibond") {
          val = computeIBondValue(asset, cd.date);
        }
        cd.values[name] = val;
      }
    }

    rebuildCumulatives(data);
  };

})(typeof module !== "undefined" && module.exports
  ? module.exports
  : (window.Portfolio = window.Portfolio || {}));
