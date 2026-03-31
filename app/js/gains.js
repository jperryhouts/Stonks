(function (exports) {
  "use strict";

  /**
   * Compute realized and unrealized capital gains from a transaction log.
   *
   * @param {Array}  trades - [{date, symbol, price, quantity, type?}] (all strings)
   * @param {Array}  market   - [{timestamp, ...prices}] from market.json
   * @returns {{ realized, donated, unrealized, summary }}
   *
   * realized entries: {date, symbol, shares, costBasis, proceeds, gain, holdDays, isLongTerm,
   *                    washSaleDisallowed?, washSaleRawGain?, washSaleReplacements?}
   * donated entries:  {date, symbol, shares, costBasis, fmv, fmvTotal, gain, holdDays, isLongTerm}
   *   fmv = per-share FMV (price field); fmvTotal = fmv*shares; gain = forgone gain (informational)
   * unrealized entries: {symbol, shares, avgCostBasis, currentPrice, currentValue, gain, isLongTerm,
   *                       stShares, ltShares, stCost, ltCost, stGain, ltGain}
   *   isLongTerm: true = all lots LT, false = all lots ST, null = mixed
   * summary: {stRealizedThisYear, ltRealizedThisYear, stUnrealized, ltUnrealized}
   *
   * Wash sale rule (IRS): if a security is sold at a loss and the same security is purchased
   * within 30 days before or after the sale, the loss is disallowed and added to the
   * replacement lot's cost basis. Detected at runtime; no data files are modified.
   */

  /** Return the ISO date string that is n days after dateStr. */
  function addDays(dateStr, n) {
    var d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Distribute wash sale disallowance pro-rata across a set of realized entries.
   * Updates each entry's gain, washSaleDisallowed, washSaleRawGain, washSaleReplacements.
   *
   * @param {Array}  entries        - realized sub-entries from the sale (mutated in place)
   * @param {number} coveredShares  - total shares covered by the replacement lot
   * @param {number} disallowed     - total dollar amount disallowed
   * @param {string} replacementDate - date of the replacement buy
   */
  function applyWashSaleToEntries(entries, coveredShares, disallowed, replacementDate) {
    var totalShares = 0;
    for (var i = 0; i < entries.length; i++) {
      totalShares += (entries[i].shares || 0);
    }
    if (totalShares < 1e-9) return;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e.shares || e.shares < 1e-9) continue;
      var portion = (e.shares / totalShares) * disallowed;
      if (e.washSaleRawGain === undefined) e.washSaleRawGain = e.gain;
      e.washSaleDisallowed = (e.washSaleDisallowed || 0) + portion;
      e.gain += portion; // reduce loss (loss is negative, disallowed is positive)
      if (!e.washSaleReplacements) e.washSaleReplacements = [];
      e.washSaleReplacements.push({
        date: replacementDate,
        shares: coveredShares * e.shares / totalShares,
      });
    }
  }

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
    var lots = {}; // symbol -> [{date, price, quantity, washAdj}]

    // Pending look-forward wash sales: losses not yet covered by a future buy.
    // Each entry: {sym, windowEnd, lossPerShare, uncoveredShares, entries}
    var pendingWashSales = [];

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
        // -----------------------------------------------------------------------
        // BUY / DRIP — check if this purchase is a replacement for a pending
        // look-forward wash sale loss before adding the lot.
        // -----------------------------------------------------------------------
        var remainingQty = qty;
        var adjustedPrice = price;

        for (var wi = 0; wi < pendingWashSales.length && remainingQty > 1e-9; wi++) {
          var ws = pendingWashSales[wi];
          if (ws.sym !== sym || tx.date > ws.windowEnd || ws.uncoveredShares < 1e-9) continue;

          var replacedShares = Math.min(remainingQty, ws.uncoveredShares);
          var disallowed = replacedShares * ws.lossPerShare;

          // Adjust cost basis of the replacement lot by the disallowed amount
          adjustedPrice = price + disallowed / replacedShares;

          // Push the replacement lot with the adjusted basis
          lots[sym].push({
            date: tx.date,
            price: adjustedPrice,
            quantity: replacedShares,
            washAdj: disallowed,
          });

          // Update realized entries to reflect the disallowed loss
          applyWashSaleToEntries(ws.entries, replacedShares, disallowed, tx.date);

          ws.uncoveredShares -= replacedShares;
          remainingQty -= replacedShares;

          // Clean up fully-resolved pending entries
          if (ws.uncoveredShares < 1e-9) {
            pendingWashSales.splice(wi, 1);
            wi--;
          }
          // Reset adjustedPrice for any remaining clean shares
          adjustedPrice = price;
        }

        // Push any remaining shares as a clean (unadjusted) lot
        if (remainingQty > 1e-9) {
          lots[sym].push({ date: tx.date, price: price, quantity: remainingQty, washAdj: 0 });
        }
      } else {
        var remaining = -qty;

        var isDonation = tx.type === "donate";

        // Track index of first new realized entry for this transaction
        var firstRealizedIdx = realized.length;

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

        // -------------------------------------------------------------------
        // WASH SALE DETECTION — applies only to non-donation sells that
        // produced a net loss (donations don't generate realized losses).
        // Only entries that are individually at a loss are eligible; gain
        // entries from the same FIFO transaction are excluded so a net-zero
        // or net-positive transaction cannot suppress wash sale detection on
        // the loss lots it contains.
        // -------------------------------------------------------------------
        if (!isDonation) {
          var newEntries = realized.slice(firstRealizedIdx).filter(function(e) { return !e.warning; });
          var lossEntries = newEntries.filter(function(e) { return e.gain < 0; });
          if (lossEntries.length > 0) {
            var totalGain = 0, totalShares = 0;
            for (var ni = 0; ni < lossEntries.length; ni++) {
              totalGain += lossEntries[ni].gain;
              totalShares += lossEntries[ni].shares;
            }

            if (totalGain < 0 && totalShares > 1e-9) {
              var lossPerShare = Math.abs(totalGain) / totalShares;
              var uncoveredShares = totalShares;
              var windowStart = addDays(tx.date, -30);
              var windowEnd = addDays(tx.date, 30);

              // Look-back: scan remaining lots for lots purchased in the 30 days
              // before the sale (these are replacement shares already in the queue).
              // Shares committed to same-date future sells are being liquidated today
              // and cannot serve as wash-sale replacements.
              var futureSameDateQty = 0;
              for (var fi = i + 1; fi < sorted.length; fi++) {
                var ft = sorted[fi];
                if (ft.date > tx.date) break;
                if (ft.symbol === sym && (ft.type === 'sell' || ft.type === 'donate')) {
                  futureSameDateQty += Math.abs(parseFloat(ft.quantity) || 0);
                }
              }
              if (lots[sym]) {
                for (var li = 0; li < lots[sym].length && uncoveredShares > 1e-9; li++) {
                  var lot = lots[sym][li];
                  if (lot.quantity < 1e-9) continue;
                  if (lot.date < windowStart || lot.date >= tx.date) continue;
                  // washRemaining caps reuse: a lot can serve as replacement for at
                  // most as many shares as it physically holds across all loss sells.
                  // Cap to lot.quantity in case FIFO sells have reduced it since it
                  // was last used as replacement.
                  var washRem = Math.min(
                    (lot.washRemaining !== undefined) ? lot.washRemaining : lot.quantity,
                    lot.quantity
                  );
                  if (washRem < 1e-9) continue;
                  // Exclude shares committed to same-date future sells
                  var sameDateReservation = Math.min(lot.quantity, futureSameDateQty);
                  futureSameDateQty -= sameDateReservation;
                  var availableQty = Math.max(0, washRem - sameDateReservation);
                  if (availableQty < 1e-9) continue;
                  // This lot was purchased within the 30-day look-back window
                  var replacedShares = Math.min(availableQty, uncoveredShares);
                  var disallowed = replacedShares * lossPerShare;
                  // If only part of the lot is needed, split it so basis adjustment
                  // applies only to the replacement shares, not the whole lot.
                  if (replacedShares < lot.quantity) {
                    var cleanShares = lot.quantity - replacedShares;
                    lots[sym].splice(li + 1, 0, { date: lot.date, price: lot.price, quantity: cleanShares, washAdj: 0,
                      washRemaining: washRem - replacedShares });
                    lot.quantity = replacedShares;
                  }
                  lot.washRemaining = 0;  // this portion's replacement capacity fully consumed
                  // Adjust the replacement lot's cost basis upward
                  lot.price += disallowed / replacedShares;
                  lot.washAdj = (lot.washAdj || 0) + disallowed;
                  // Update realized entries
                  applyWashSaleToEntries(lossEntries, replacedShares, disallowed, lot.date);
                  uncoveredShares -= replacedShares;
                }
              }

              // Look-forward: register remaining uncovered loss shares so future
              // buys within the 30-day window can claim them.
              if (uncoveredShares > 1e-9) {
                pendingWashSales.push({
                  sym: sym,
                  windowEnd: windowEnd,
                  lossPerShare: lossPerShare,
                  uncoveredShares: uncoveredShares,
                  entries: lossEntries,
                });
              }
            }
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
