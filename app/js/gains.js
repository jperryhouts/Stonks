(function (exports) {
  "use strict";

  /**
   * Compute realized and unrealized capital gains from a transaction log.
   *
   * @param {Array}  trades - [{date, symbol, price, quantity, type?}] (all strings)
   * @param {Array}  market   - [{timestamp, ...prices}] from market.json
   * @returns {{ realized, donated, unrealized, summary }}
   *
   * realized entries: {date, symbol, shares, costBasis, proceeds, gain, holdDays, isLongTerm}
   * donated entries:  {date, symbol, shares, costBasis, fmv, fmvTotal, gain, holdDays, isLongTerm}
   *   fmv = per-share FMV (price field); fmvTotal = fmv*shares; gain = forgone gain (informational)
   * unrealized entries: {symbol, shares, avgCostBasis, currentPrice, currentValue, gain, isLongTerm,
   *                       stShares, ltShares, stCost, ltCost, stGain, ltGain}
   *   isLongTerm: true = all lots LT, false = all lots ST, null = mixed
   * summary: {stRealizedThisYear, ltRealizedThisYear, stUnrealized, ltUnrealized}
   */
  function computeGains(trades, market) {
    // Build last known price per symbol (iterate forward; later rows overwrite earlier ones)
    var lastPrices = {}; // symbol -> {price, date}
    for (var mi = 0; mi < market.length; mi++) {
      var row = market[mi];
      var rowDate = (row.timestamp || "").slice(0, 10);
      for (var key in row) {
        if (key === "timestamp") continue;
        var p = parseFloat(row[key]);
        if (!isNaN(p) && p > 0) lastPrices[key] = { price: p, date: rowDate };
      }
    }

    // Sort trades by date ascending
    var sorted = trades.slice().sort(function (a, b) {
      return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    });

    var thisYear = new Date().getFullYear().toString();
    var realized = [];
    var donated = [];

    // -------------------------------------------------------------------------
    // FIFO method
    // -------------------------------------------------------------------------
    var lots = {}; // symbol -> [{date, price, quantity}]

    for (var i = 0; i < sorted.length; i++) {
      var tx = sorted[i];
      var qty = parseFloat(tx.quantity);
      if (tx.type === "buy" || tx.type === "drip") qty = Math.abs(qty);
      else if (tx.type === "sell" || tx.type === "donate") qty = -Math.abs(qty);
      var price = parseFloat(tx.price);
      if (isNaN(qty) || isNaN(price) || qty === 0) continue;

      var sym = tx.symbol;
      if (!lots[sym]) lots[sym] = [];

      if (qty > 0) {
        lots[sym].push({ date: tx.date, price: price, quantity: qty });
      } else {
        var remaining = -qty;

        var isDonation = tx.type === "donate";

        if (tx.lotDate) {
          // Specific identification: consume from lots matching the specified buy date
          var foundAny = false;
          for (var li = 0; li < lots[sym].length && remaining > 1e-9; li++) {
            var lot = lots[sym][li];
            if (lot.date !== tx.lotDate || lot.quantity < 1e-9) continue;
            foundAny = true;
            var consumed = Math.min(lot.quantity, remaining);
            var holdDays = Math.round((new Date(tx.date + "T00:00:00") - new Date(lot.date + "T00:00:00")) / 86400000);
            var lotCost = consumed * lot.price;
            if (isDonation) {
              donated.push({
                date: tx.date,
                symbol: sym,
                shares: consumed,
                costBasis: lotCost,
                fmv: price,
                fmvTotal: consumed * price,
                gain: consumed * price - lotCost,
                holdDays: holdDays,
                isLongTerm: holdDays > 365,
              });
            } else {
              realized.push({
                date: tx.date,
                symbol: sym,
                shares: consumed,
                costBasis: lotCost,
                proceeds: consumed * price,
                gain: consumed * (price - lot.price),
                holdDays: holdDays,
                isLongTerm: holdDays > 365,
              });
            }
            lot.quantity -= consumed;
            remaining -= consumed;
          }
          if (!foundAny) {
            realized.push({
              date: tx.date, symbol: sym, shares: -qty,
              costBasis: 0, proceeds: price * -qty, gain: 0,
              holdDays: null, isLongTerm: null,
              warning: "No lot found for " + sym + " purchased on " + tx.lotDate,
            });
          } else if (remaining > 1e-9) {
            realized.push({
              date: tx.date, symbol: sym, shares: remaining,
              costBasis: 0, proceeds: price * remaining, gain: 0,
              holdDays: null, isLongTerm: null,
              warning: "Lot " + tx.lotDate + " has insufficient shares (" +
                       remaining.toFixed(4) + " short)" +
                       " — this can happen if your trade history doesn't cover all original purchases",
            });
          }
        } else {
          // FIFO
          while (remaining > 1e-9 && lots[sym].length > 0) {
            var lot = lots[sym][0];
            var consumed = Math.min(lot.quantity, remaining);
            var holdDays = Math.round(
              (new Date(tx.date + "T00:00:00") - new Date(lot.date + "T00:00:00")) / 86400000
            );
            var costBasis = consumed * lot.price;
            if (isDonation) {
              donated.push({
                date: tx.date,
                symbol: sym,
                shares: consumed,
                costBasis: costBasis,
                fmv: price,
                fmvTotal: consumed * price,
                gain: consumed * price - costBasis,
                holdDays: holdDays,
                isLongTerm: holdDays > 365,
              });
            } else {
              var proceeds = consumed * price;
              realized.push({
                date: tx.date,
                symbol: sym,
                shares: consumed,
                costBasis: costBasis,
                proceeds: proceeds,
                gain: proceeds - costBasis,
                holdDays: holdDays,
                isLongTerm: holdDays > 365,
              });
            }
            lot.quantity -= consumed;
            remaining -= consumed;
            if (lot.quantity < 1e-9) lots[sym].shift();
          }
          if (remaining > 1e-9) {
            realized.push({
              date: tx.date, symbol: sym, shares: remaining,
              costBasis: 0, proceeds: price * remaining, gain: 0,
              holdDays: null, isLongTerm: null,
              warning: "Insufficient shares: attempted to sell " + remaining.toFixed(4) +
                       " more " + sym + " than owned" +
                       " — this can happen if your trade history doesn't cover all original purchases",
            });
          }
        }
      }
    }

    // Compute unrealized from remaining lots and split ST/LT simultaneously
    var unrealized = [];
    var stUnrealized = 0, ltUnrealized = 0;

    for (var sym in lots) {
      var lotList = lots[sym];
      if (!lotList.length) continue;

      var totalShares = 0, totalCost = 0;
      var hasLT = false, hasST = false;
      var stShares = 0, ltShares = 0;
      var stCost = 0, ltCost = 0;
      var stGain = 0, ltGain = 0;
      var lotDetails = [];

      var lastInfo = lastPrices[sym];
      var currentPrice = lastInfo ? lastInfo.price : 0;
      var currentDate = lastInfo ? lastInfo.date : null;

      for (var li = 0; li < lotList.length; li++) {
        var lot = lotList[li];
        if (lot.quantity < 1e-9) continue;
        totalShares += lot.quantity;
        totalCost += lot.quantity * lot.price;

        if (currentDate) {
          var holdDays = Math.round(
            (new Date(currentDate + "T00:00:00") - new Date(lot.date + "T00:00:00")) / 86400000
          );
          var lotGain = lot.quantity * (currentPrice - lot.price);
          var isLotLT = holdDays > 365;
          if (isLotLT) {
            hasLT = true;
            ltUnrealized += lotGain;
            ltShares += lot.quantity;
            ltCost += lot.quantity * lot.price;
            ltGain += lotGain;
          } else {
            hasST = true;
            stUnrealized += lotGain;
            stShares += lot.quantity;
            stCost += lot.quantity * lot.price;
            stGain += lotGain;
          }
          lotDetails.push({ date: lot.date, price: lot.price, quantity: lot.quantity,
            holdDays: holdDays, gain: lotGain, isLongTerm: isLotLT });
        } else {
          lotDetails.push({ date: lot.date, price: lot.price, quantity: lot.quantity,
            holdDays: null, gain: 0, isLongTerm: null });
        }
      }

      if (totalShares < 1e-6) continue;

      // null = mixed (has both ST and LT lots)
      var isLongTerm = (hasLT && !hasST) ? true : (!hasLT && hasST) ? false : null;

      unrealized.push({
        symbol: sym,
        shares: totalShares,
        avgCostBasis: totalCost / totalShares,
        currentPrice: currentPrice,
        currentValue: currentPrice * totalShares,
        gain: currentPrice * totalShares - totalCost,
        isLongTerm: isLongTerm,
        stShares: stShares,
        ltShares: ltShares,
        stCost: stCost,
        ltCost: ltCost,
        stGain: stGain,
        ltGain: ltGain,
        lotDetails: lotDetails,
      });
    }

    var stRealizedThisYear = 0, ltRealizedThisYear = 0;
    for (var ri = 0; ri < realized.length; ri++) {
      if (realized[ri].date.slice(0, 4) === thisYear) {
        if (realized[ri].isLongTerm) ltRealizedThisYear += realized[ri].gain;
        else stRealizedThisYear += realized[ri].gain;
      }
    }

    return {
      realized: realized,
      donated: donated,
      unrealized: unrealized,
      summary: {
        stRealizedThisYear: stRealizedThisYear,
        ltRealizedThisYear: ltRealizedThisYear,
        stUnrealized: stUnrealized,
        ltUnrealized: ltUnrealized,
      },
    };
  }

  exports.computeGains = computeGains;
})(typeof module !== "undefined" && module.exports
  ? module.exports
  : (window.Portfolio = window.Portfolio || {}));
