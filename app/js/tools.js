(function (exports) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Resolve the list of EXPOSURE_MAP category names for a rebalancing config entry. */
  function resolveCatNames(entry) {
    if (entry.subcategories) {
      return entry.subcategories.split(",").map(function (s) { return s.trim(); });
    }
    if (entry.category) return [entry.category];
    return [];
  }

  // ---------------------------------------------------------------------------
  // Pure computation
  // ---------------------------------------------------------------------------

  /**
   * Compute implied targets for tradeable symbols using a greedy linear solver.
   *
   * For each rebalancing category, computes "available" = targetValue minus the
   * sum of non-tradeable contributions. Then iteratively sizes each tradeable
   * symbol from the category where it is the UNIQUE remaining unsized tradeable,
   * provided that every other category where that symbol appears retains at least
   * one other unsized tradeable symbol (so those categories remain resolvable).
   * Falls back to proportional allocation for symbols that cannot be uniquely
   * determined this way (e.g. a single symbol spanning multiple categories with
   * no other tradeables).
   *
   * @param {object}       exposureMap - { symbol: { catName: fraction } }
   * @param {Array}        categories  - internal category objects (with catNames, targetValue)
   * @param {object}       values      - { symbol: currentValue }
   * @param {string[]|null} tradeable  - tradeable symbols, or null (all in exposureMap)
   * @returns {{ impliedTargets: object, sized: object }}
   */
  function computeGreedyImpliedTargets(exposureMap, categories, values, tradeable) {
    // Build per-category state: available budget and effective fractions per tradeable.
    var catStates = categories.map(function (cat) {
      var available = cat.targetValue;
      var effFrac = {};
      for (var s in exposureMap) {
        var isTradeable = (tradeable === null || tradeable.indexOf(s) !== -1);
        var ef = 0;
        for (var ni = 0; ni < cat.catNames.length; ni++) {
          ef += (exposureMap[s][cat.catNames[ni]] || 0);
        }
        if (ef <= 0) continue;
        if (isTradeable) {
          effFrac[s] = ef;
        } else {
          available -= (values[s] || 0) * ef;
        }
      }
      return { available: available, effFrac: effFrac };
    });

    var impliedTargets = {};
    var sized = {};

    var changed = true;
    while (changed) {
      changed = false;
      for (var ci = 0; ci < catStates.length; ci++) {
        var cs = catStates[ci];
        // Collect unsized tradeable symbols in this category.
        var unsized = [];
        for (var s in cs.effFrac) {
          if (!sized[s]) unsized.push(s);
        }
        if (unsized.length !== 1) continue;

        var sym = unsized[0];

        // Smart check: only size this symbol here if every OTHER category where
        // this symbol appears still has at least one OTHER unsized tradeable.
        // This prevents prematurely assigning a symbol and leaving another
        // category with no way to be satisfied.
        var canSize = true;
        for (var oci = 0; oci < catStates.length; oci++) {
          if (oci === ci) continue;
          var ocs = catStates[oci];
          if (!ocs.effFrac[sym]) continue;
          var otherCount = 0;
          for (var s2 in ocs.effFrac) {
            if (!sized[s2] && s2 !== sym) otherCount++;
          }
          if (otherCount === 0) { canSize = false; break; }
        }
        if (!canSize) continue;

        // Size the symbol from this category.
        var ef = cs.effFrac[sym];
        impliedTargets[sym] = ef > 0 ? Math.max(0, cs.available / ef) : 0;
        sized[sym] = true;

        // Propagate: deduct this symbol's contribution from all other categories.
        for (var pci = 0; pci < catStates.length; pci++) {
          if (pci !== ci && catStates[pci].effFrac[sym]) {
            catStates[pci].available -= impliedTargets[sym] * catStates[pci].effFrac[sym];
          }
        }

        changed = true;
        break; // restart to pick up newly unambiguous categories
      }
    }

    return { impliedTargets: impliedTargets, sized: sized };
  }

  /**
   * Compute rebalancing data.
   *
   * @param {object} fullData         - { symbols, chartData: [{date, values}] }
   * @param {object} exposureMap      - { symbol: { category: fraction } }
   * @param {Array}  rebalCats        - [{ name, category? subcategories? }]
   * @param {object} targets          - { categoryName: percentage (number) }
   * @param {object} [options]        - optional config
   *   options.tradeable {string[]}   - if set, only these symbols get impliedTarget/buySell;
   *                                    other mapped symbols get null for those fields
   *   options.exclude   {string[]}   - symbols to omit entirely from tickers output
   * @returns {{ portfolioTotal, categories, tickers }}
   *
   * categories: [{ name, currentValue, currentPct, targetPct, targetValue, buySell }]
   * tickers:    [{ symbol, currentValue, currentPct, impliedTarget, buySell }]
   *   impliedTarget/buySell are null for unmapped or non-tradeable symbols
   */
  function computeRebalancing(fullData, exposureMap, rebalCats, targets, options) {
    var tradeable = (options && Array.isArray(options.tradeable)) ? options.tradeable : null;
    var exclude = (options && Array.isArray(options.exclude)) ? options.exclude : [];

    if (!fullData || !fullData.chartData || fullData.chartData.length === 0) {
      return { portfolioTotal: 0, categories: [], tickers: [] };
    }

    var values = fullData.chartData[fullData.chartData.length - 1].values || {};

    // Portfolio total = sum of all mapped symbols (fractions per symbol sum to 1)
    var portfolioTotal = 0;
    for (var sym in exposureMap) {
      portfolioTotal += values[sym] || 0;
    }

    // Build category objects (keep catNames for internal use during ticker calc)
    var categories = rebalCats.map(function (rc) {
      var catNames = resolveCatNames(rc);
      var currentValue = 0;
      for (var s in exposureMap) {
        for (var ci = 0; ci < catNames.length; ci++) {
          var frac = exposureMap[s][catNames[ci]];
          if (frac) currentValue += (values[s] || 0) * frac;
        }
      }
      var currentPct = portfolioTotal > 0 ? (currentValue / portfolioTotal) * 100 : 0;
      var targetPct = targets[rc.name] || 0;
      var targetValue = (targetPct / 100) * portfolioTotal;
      return {
        name: rc.name,
        catNames: catNames,
        currentValue: currentValue,
        currentPct: currentPct,
        targetPct: targetPct,
        targetValue: targetValue,
        buySell: targetValue - currentValue,
      };
    });

    // Precompute implied targets using the greedy linear solver. This correctly
    // handles tickers that span multiple categories by solving the allocation
    // constraints as a system rather than independently per-category.
    var greedyResult = portfolioTotal > 0
      ? computeGreedyImpliedTargets(exposureMap, categories, values, tradeable)
      : { impliedTargets: {}, sized: {} };

    // Build ticker objects
    var tickers = (fullData.symbols || []).map(function (symbol) {
      // Excluded symbols are dropped entirely
      if (exclude.indexOf(symbol) !== -1) {
        return null;
      }

      var currentValue = values[symbol] || 0;
      var currentPct = portfolioTotal > 0 ? (currentValue / portfolioTotal) * 100 : 0;

      if (!exposureMap[symbol]) {
        return { symbol: symbol, currentValue: currentValue, currentPct: currentPct,
                 impliedTarget: null, buySell: null };
      }

      // Non-tradeable mapped symbols: include in output but suppress buy/sell guidance
      if (tradeable !== null && tradeable.indexOf(symbol) === -1) {
        return { symbol: symbol, currentValue: currentValue, currentPct: currentPct,
                 impliedTarget: null, buySell: null };
      }

      var impliedTarget;
      if (greedyResult.sized[symbol]) {
        // Uniquely determined by the greedy linear solver.
        impliedTarget = greedyResult.impliedTargets[symbol];
      } else {
        // Fallback: proportional share of each category's target value.
        // Used when the system is under/over-determined (e.g. a single ticker
        // that spans multiple categories with no other tradeables available).
        impliedTarget = 0;
        for (var ci = 0; ci < categories.length; ci++) {
          var cat = categories[ci];
          if (cat.currentValue <= 0) continue;
          for (var ni = 0; ni < cat.catNames.length; ni++) {
            var frac = exposureMap[symbol][cat.catNames[ni]];
            if (frac) {
              var tickerContribToCat = currentValue * frac;
              impliedTarget += (tickerContribToCat / cat.currentValue) * cat.targetValue;
            }
          }
        }
      }

      return {
        symbol: symbol,
        currentValue: currentValue,
        currentPct: currentPct,
        impliedTarget: impliedTarget,
        buySell: impliedTarget - currentValue,
      };
    }).filter(function (t) { return t !== null; });

    // Strip internal catNames field from output
    categories = categories.map(function (c) {
      return {
        name: c.name,
        currentValue: c.currentValue,
        currentPct: c.currentPct,
        targetPct: c.targetPct,
        targetValue: c.targetValue,
        buySell: c.buySell,
      };
    });

    return { portfolioTotal: portfolioTotal, categories: categories, tickers: tickers };
  }

  /**
   * Compute contribution allocation data.
   *
   * Given a contribution `amount`, determines how to allocate it across tradeable
   * symbols to move the portfolio toward target allocations (Approach A: targets
   * are computed against portfolioTotal + amount).
   *
   * @param {object}       fullData        - { symbols, chartData: [{date, values}] }
   * @param {object}       exposureMap     - { symbol: { category: fraction } }
   * @param {Array}        rebalCats       - [{ name, category? subcategories? }]
   * @param {object}       targets         - { categoryName: percentage (number) }
   * @param {number}       amount          - dollar amount to contribute (negative to withdraw)
   * @param {object}       [options]       - optional config (tradeable, exclude)
   * @returns {{ portfolioTotal, newTotal, categories, tickers }}
   *
   * categories: [{ name, currentValue, currentPct, targetPct, contribution }]
   * tickers:    [{ symbol, currentValue, currentPct, impliedTarget, contribution }]
   *   impliedTarget/contribution are null for unmapped or non-tradeable symbols
   */
  function computeContributions(fullData, exposureMap, rebalCats, targets, amount, options) {
    var tradeable = (options && Array.isArray(options.tradeable)) ? options.tradeable : null;
    var exclude = (options && Array.isArray(options.exclude)) ? options.exclude : [];

    if (!fullData || !fullData.chartData || fullData.chartData.length === 0) {
      return { portfolioTotal: 0, newTotal: Math.max(0, amount), categories: [], tickers: [] };
    }

    var values = fullData.chartData[fullData.chartData.length - 1].values || {};

    // Portfolio total (current, before contribution)
    var portfolioTotal = 0;
    for (var sym in exposureMap) {
      portfolioTotal += values[sym] || 0;
    }
    // Guard: cannot withdraw more than the portfolio is worth
    if (portfolioTotal + amount < 0) { amount = -portfolioTotal; }
    var newTotal = portfolioTotal + amount;

    // Build category objects with targetValue based on newTotal
    var categories = rebalCats.map(function (rc) {
      var catNames = resolveCatNames(rc);
      var currentValue = 0;
      for (var s in exposureMap) {
        for (var ci = 0; ci < catNames.length; ci++) {
          var frac = exposureMap[s][catNames[ci]];
          if (frac) currentValue += (values[s] || 0) * frac;
        }
      }
      var currentPct = portfolioTotal > 0 ? (currentValue / portfolioTotal) * 100 : 0;
      var targetPct = targets[rc.name] || 0;
      var targetValue = (targetPct / 100) * newTotal;
      return {
        name: rc.name,
        catNames: catNames,
        currentValue: currentValue,
        currentPct: currentPct,
        targetPct: targetPct,
        targetValue: targetValue,
      };
    });

    // Run the greedy solver with newTotal-based targets
    var greedyResult = newTotal > 0
      ? computeGreedyImpliedTargets(exposureMap, categories, values, tradeable)
      : { impliedTargets: {}, sized: {} };

    // Compute per-ticker implied targets and raw deltas (clipped to >= 0)
    var tradeableSyms = tradeable !== null
      ? tradeable.filter(function (s) { return exposureMap[s]; })
      : Object.keys(exposureMap);

    var impliedTargetMap = {};
    var deltas = {};
    tradeableSyms.forEach(function (sym) {
      if (exclude.indexOf(sym) !== -1) return;
      var currentValue = values[sym] || 0;
      var impliedTarget;
      if (greedyResult.sized[sym]) {
        impliedTarget = greedyResult.impliedTargets[sym];
      } else {
        // Proportional fallback: same logic as computeRebalancing, extended
        // for empty portfolios (cat.currentValue === 0) where the ticker's
        // exposure fraction is used directly as its share of the category target.
        impliedTarget = 0;
        for (var ci = 0; ci < categories.length; ci++) {
          var cat = categories[ci];
          for (var ni = 0; ni < cat.catNames.length; ni++) {
            var frac = exposureMap[sym][cat.catNames[ni]];
            if (frac) {
              if (cat.currentValue <= 0) {
                impliedTarget += frac * cat.targetValue;
              } else {
                var tickerContrib = currentValue * frac;
                impliedTarget += (tickerContrib / cat.currentValue) * cat.targetValue;
              }
            }
          }
        }
      }
      impliedTargetMap[sym] = impliedTarget;
      deltas[sym] = amount >= 0
        ? Math.max(0, impliedTarget - currentValue)
        : Math.max(0, currentValue - impliedTarget);
    });

    // Normalize deltas to sum exactly to amount
    var totalDelta = 0;
    for (var s in deltas) totalDelta += deltas[s];

    var contributions = {};
    if (totalDelta > 0) {
      for (var s2 in deltas) {
        contributions[s2] = deltas[s2] * amount / totalDelta;
      }
    } else {
      // Pro-rata fallback: distribute by current weight among tradeable symbols.
      // When all tradeable values are zero, distribute equally instead.
      var totalCurrent = 0;
      var eligibleSyms = [];
      tradeableSyms.forEach(function (sym) {
        if (exclude.indexOf(sym) === -1) {
          totalCurrent += values[sym] || 0;
          eligibleSyms.push(sym);
        }
      });
      eligibleSyms.forEach(function (sym) {
        var w = totalCurrent > 0 ? (values[sym] || 0) / totalCurrent : 1 / eligibleSyms.length;
        contributions[sym] = w * amount;
      });
    }

    // Build ticker output
    var tickers = (fullData.symbols || []).map(function (symbol) {
      if (exclude.indexOf(symbol) !== -1) return null;
      var currentValue = values[symbol] || 0;
      var currentPct = portfolioTotal > 0 ? (currentValue / portfolioTotal) * 100 : 0;

      if (!exposureMap[symbol]) {
        return { symbol: symbol, currentValue: currentValue, currentPct: currentPct,
                 impliedTarget: null, contribution: null };
      }
      if (tradeable !== null && tradeable.indexOf(symbol) === -1) {
        return { symbol: symbol, currentValue: currentValue, currentPct: currentPct,
                 impliedTarget: null, contribution: null };
      }

      return {
        symbol: symbol,
        currentValue: currentValue,
        currentPct: currentPct,
        impliedTarget: impliedTargetMap[symbol] !== undefined ? impliedTargetMap[symbol] : null,
        contribution: contributions[symbol] !== undefined ? contributions[symbol] : 0,
      };
    }).filter(function (t) { return t !== null; });

    // Build category output: each category's contribution = sum of ticker contributions * exposure frac
    var catResults = categories.map(function (cat) {
      var catContrib = 0;
      for (var s in contributions) {
        for (var ni = 0; ni < cat.catNames.length; ni++) {
          var frac = exposureMap[s] && exposureMap[s][cat.catNames[ni]];
          if (frac) catContrib += contributions[s] * frac;
        }
      }
      return {
        name: cat.name,
        currentValue: cat.currentValue,
        currentPct: cat.currentPct,
        targetPct: cat.targetPct,
        contribution: catContrib,
      };
    });

    return {
      portfolioTotal: portfolioTotal,
      newTotal: newTotal,
      categories: catResults,
      tickers: tickers,
    };
  }

  // ---------------------------------------------------------------------------
  // DOM builder (called from app.js — implemented in Task 6)
  // ---------------------------------------------------------------------------

  function buildToolsPanel(fullData, exposureMap, rebalancingConfig) {
    var container = document.getElementById("panel-tools");
    if (!container) return;
    container.innerHTML = "";

    var cats = rebalancingConfig.categories || [];
    var defaultTargets = rebalancingConfig.targets || {};

    // Live target state shared across both sub-tabs
    var liveTargets = {};
    cats.forEach(function (rc) {
      liveTargets[rc.name] = defaultTargets[rc.name] || 0;
    });

    // --- Shared section: target inputs + validation hint ---
    var sharedSection = document.createElement("div");
    sharedSection.className = "tools-shared";

    var targetsRow = document.createElement("div");
    targetsRow.className = "rebal-targets";

    var inputs = {};
    cats.forEach(function (rc) {
      var field = document.createElement("div");
      field.className = "rebal-target-field";

      var label = document.createElement("div");
      label.className = "rebal-target-label";
      label.textContent = rc.name;

      var wrap = document.createElement("div");
      wrap.className = "rebal-target-input-wrap";

      var inp = document.createElement("input");
      inp.type = "number";
      inp.className = "rebal-target-input";
      inp.min = "0";
      inp.max = "100";
      inp.step = "1";
      inp.value = String(liveTargets[rc.name]);
      inputs[rc.name] = inp;

      var pctLabel = document.createElement("span");
      pctLabel.className = "rebal-target-pct";
      pctLabel.textContent = "%";

      wrap.appendChild(inp);
      wrap.appendChild(pctLabel);
      field.appendChild(label);
      field.appendChild(wrap);
      targetsRow.appendChild(field);
    });

    sharedSection.appendChild(targetsRow);

    var validationHint = document.createElement("div");
    validationHint.className = "rebal-validation";
    sharedSection.appendChild(validationHint);

    // --- Sub-tab bar ---
    var subtabBar = document.createElement("div");
    subtabBar.className = "tools-subtabs";

    var rebalBtn = document.createElement("button");
    rebalBtn.className = "tools-subtab active";
    rebalBtn.textContent = "Rebalancing";

    var contribBtn = document.createElement("button");
    contribBtn.className = "tools-subtab";
    contribBtn.textContent = "Contributions";

    subtabBar.appendChild(rebalBtn);
    subtabBar.appendChild(contribBtn);
    container.appendChild(subtabBar);

    container.appendChild(sharedSection);

    // --- Rebalancing sub-panel ---
    var rebalPanel = document.createElement("div");
    rebalPanel.id = "tools-rebal-panel";
    var rebalOutputArea = document.createElement("div");
    rebalPanel.appendChild(rebalOutputArea);
    container.appendChild(rebalPanel);

    // --- Contributions sub-panel ---
    var contribPanel = document.createElement("div");
    contribPanel.id = "tools-contrib-panel";
    contribPanel.className = "hidden";

    var amountRow = document.createElement("div");
    amountRow.className = "contrib-amount-row";

    var amountLabel = document.createElement("label");
    amountLabel.className = "contrib-amount-label";
    amountLabel.textContent = "Amount (negative to withdraw)";

    var amountWrap = document.createElement("div");
    amountWrap.className = "contrib-amount-input-wrap";

    var dollarSign = document.createElement("span");
    dollarSign.className = "contrib-dollar";
    dollarSign.textContent = "$";

    var amountInput = document.createElement("input");
    amountInput.type = "number";
    amountInput.id = "tools-contrib-amount";
    amountInput.className = "contrib-amount-input";
    amountInput.step = "100";
    amountInput.placeholder = "0";
    amountInput.value = "";

    amountWrap.appendChild(dollarSign);
    amountWrap.appendChild(amountInput);
    amountRow.appendChild(amountLabel);
    amountRow.appendChild(amountWrap);
    contribPanel.appendChild(amountRow);

    var contribOutputArea = document.createElement("div");
    contribPanel.appendChild(contribOutputArea);

    container.appendChild(contribPanel);

    // --- Sub-tab switching ---
    rebalBtn.addEventListener("click", function () {
      rebalBtn.classList.add("active");
      contribBtn.classList.remove("active");
      rebalPanel.classList.remove("hidden");
      contribPanel.classList.add("hidden");
    });

    contribBtn.addEventListener("click", function () {
      contribBtn.classList.add("active");
      rebalBtn.classList.remove("active");
      contribPanel.classList.remove("hidden");
      rebalPanel.classList.add("hidden");
    });

    // --- Shared helpers ---
    function fmtPct(v) { return v.toFixed(1) + "%"; }
    function fmtBuySell(v) {
      if (v === null) return null;
      var abs = Math.abs(v);
      var str = Portfolio.fmtDollar(abs);
      return { text: (v > 0.005 ? "Buy " : v < -0.005 ? "Sell " : "") + str,
               cls: v > 0.005 ? "rebal-buy" : v < -0.005 ? "rebal-sell" : "rebal-zero" };
    }
    function fmtOverUnder(v) {
      if (v === null) return null;
      var abs = Math.abs(v);
      var str = Portfolio.fmtDollar(abs);
      return { text: (v > 0.005 ? "Under " : v < -0.005 ? "Over " : "") + str,
               cls: v > 0.005 ? "rebal-buy" : v < -0.005 ? "rebal-sell" : "rebal-zero" };
    }

    // --- Rebalancing render ---
    function renderRebal() {
      cats.forEach(function (rc) {
        liveTargets[rc.name] = parseFloat(inputs[rc.name].value) || 0;
      });

      var sum = cats.reduce(function (s, rc) { return s + liveTargets[rc.name]; }, 0);
      validationHint.textContent = (Math.abs(sum - 100) > 0.01)
        ? "Targets sum to " + sum.toFixed(1) + "% — adjust to 100% for a balanced result"
        : "";

      var result = computeRebalancing(fullData, exposureMap, cats, liveTargets, {
        tradeable: rebalancingConfig.tradeable || null,
        exclude: rebalancingConfig.exclude || [],
      });
      rebalOutputArea.innerHTML = "";

      // Category summary table
      var catTitle = document.createElement("div");
      catTitle.className = "rebal-section-title";
      catTitle.textContent = "By Category";
      rebalOutputArea.appendChild(catTitle);

      var catTable = document.createElement("table");
      catTable.className = "rebal-table";
      var thead = document.createElement("thead");
      thead.innerHTML = "<tr><th>Category</th><th>Current</th><th>Current %</th>" +
        "<th>Target %</th><th>Difference</th><th>Over / Under</th></tr>";
      catTable.appendChild(thead);
      var tbody = document.createElement("tbody");
      result.categories.forEach(function (cat) {
        var tr = document.createElement("tr");
        var diff = cat.currentPct - cat.targetPct;
        var bs = fmtOverUnder(cat.buySell);
        var tdName = document.createElement("td"); tdName.textContent = cat.name; tr.appendChild(tdName);
        var tdCur = document.createElement("td"); tdCur.innerHTML = Portfolio.fmtDollar(cat.currentValue); tr.appendChild(tdCur);
        var tdCurPct = document.createElement("td"); tdCurPct.textContent = fmtPct(cat.currentPct); tr.appendChild(tdCurPct);
        var tdTgt = document.createElement("td"); tdTgt.textContent = fmtPct(cat.targetPct); tr.appendChild(tdTgt);
        var tdDiff = document.createElement("td");
        tdDiff.className = diff > 0.05 ? "rebal-sell" : diff < -0.05 ? "rebal-buy" : "rebal-zero";
        tdDiff.textContent = (diff >= 0 ? "+" : "") + fmtPct(diff);
        tr.appendChild(tdDiff);
        var tdBs = document.createElement("td"); tdBs.className = bs.cls; tdBs.textContent = bs.text; tr.appendChild(tdBs);
        tbody.appendChild(tr);
      });
      catTable.appendChild(tbody);
      var tfoot = document.createElement("tfoot");
      tfoot.innerHTML = "<tr><td>Total</td><td>" + Portfolio.fmtDollar(result.portfolioTotal) +
        "</td><td>100.0%</td><td>" + fmtPct(sum) + "</td><td></td><td></td></tr>";
      catTable.appendChild(tfoot);
      rebalOutputArea.appendChild(catTable);

      // Per-ticker table
      var tickTitle = document.createElement("div");
      tickTitle.className = "rebal-section-title";
      tickTitle.textContent = "By Ticker";
      rebalOutputArea.appendChild(tickTitle);

      var tickTable = document.createElement("table");
      tickTable.className = "rebal-table";
      var thead2 = document.createElement("thead");
      thead2.innerHTML = "<tr><th>Ticker</th><th>Current Value</th><th>Current %</th>" +
        "<th>Implied Target</th><th>Buy / Sell</th></tr>";
      tickTable.appendChild(thead2);
      var tbody2 = document.createElement("tbody");
      result.tickers.forEach(function (t) {
        if (t.currentValue <= 0) return;
        var tr = document.createElement("tr");
        var tdSym = document.createElement("td"); tdSym.textContent = t.symbol; tr.appendChild(tdSym);
        var tdVal = document.createElement("td"); tdVal.innerHTML = Portfolio.fmtDollar(t.currentValue); tr.appendChild(tdVal);
        var tdPct = document.createElement("td"); tdPct.textContent = fmtPct(t.currentPct); tr.appendChild(tdPct);
        var tdImp = document.createElement("td");
        if (t.impliedTarget === null) { tdImp.className = "rebal-dash"; tdImp.textContent = "\u2014"; }
        else { tdImp.innerHTML = Portfolio.fmtDollar(t.impliedTarget); }
        tr.appendChild(tdImp);
        var tdBs2 = document.createElement("td");
        if (t.buySell === null) { tdBs2.className = "rebal-dash"; tdBs2.textContent = "\u2014"; }
        else { var bs2 = fmtBuySell(t.buySell); tdBs2.className = bs2.cls; tdBs2.textContent = bs2.text; }
        tr.appendChild(tdBs2);
        tbody2.appendChild(tr);
      });
      tickTable.appendChild(tbody2);
      rebalOutputArea.appendChild(tickTable);
    }

    // --- Contributions render ---
    function renderContrib() {
      cats.forEach(function (rc) {
        liveTargets[rc.name] = parseFloat(inputs[rc.name].value) || 0;
      });

      var sum = cats.reduce(function (s, rc) { return s + liveTargets[rc.name]; }, 0);
      validationHint.textContent = (Math.abs(sum - 100) > 0.01)
        ? "Targets sum to " + sum.toFixed(1) + "% — adjust to 100% for a balanced result"
        : "";

      var amount = parseFloat(amountInput.value) || 0;
      var result = computeContributions(fullData, exposureMap, cats, liveTargets, amount, {
        tradeable: rebalancingConfig.tradeable || null,
        exclude: rebalancingConfig.exclude || [],
      });
      contribOutputArea.innerHTML = "";

      if (amount === 0) {
        var placeholder = document.createElement("div");
        placeholder.className = "contrib-placeholder";
        placeholder.textContent = "Enter an amount above to see allocation guidance.";
        contribOutputArea.appendChild(placeholder);
        return;
      }

      // Category summary table
      var catTitle = document.createElement("div");
      catTitle.className = "rebal-section-title";
      catTitle.textContent = "By Category";
      contribOutputArea.appendChild(catTitle);

      var catTable = document.createElement("table");
      catTable.className = "rebal-table";
      var thead = document.createElement("thead");
      thead.innerHTML = "<tr><th>Category</th><th>Current Value</th><th>Current %</th>" +
        "<th>Target %</th><th>Buy / Sell</th><th>New Value</th><th>New %</th></tr>";
      catTable.appendChild(thead);
      var tbody = document.createElement("tbody");
      result.categories.forEach(function (cat) {
        var newCatValue = cat.currentValue + cat.contribution;
        var newCatPct = result.newTotal > 0 ? (newCatValue / result.newTotal) * 100 : 0;
        var tr = document.createElement("tr");
        var tdName = document.createElement("td"); tdName.textContent = cat.name; tr.appendChild(tdName);
        var tdCur = document.createElement("td"); tdCur.innerHTML = Portfolio.fmtDollar(cat.currentValue); tr.appendChild(tdCur);
        var tdCurPct = document.createElement("td"); tdCurPct.textContent = fmtPct(cat.currentPct); tr.appendChild(tdCurPct);
        var tdTgt = document.createElement("td"); tdTgt.textContent = fmtPct(cat.targetPct); tr.appendChild(tdTgt);
        var tdBuy = document.createElement("td");
        tdBuy.className = cat.contribution > 0.005 ? "rebal-buy"
          : cat.contribution < -0.005 ? "rebal-sell"
          : "rebal-zero";
        tdBuy.innerHTML = Portfolio.fmtDollar(cat.contribution);
        tr.appendChild(tdBuy);
        var tdNewVal = document.createElement("td"); tdNewVal.innerHTML = Portfolio.fmtDollar(newCatValue); tr.appendChild(tdNewVal);
        var tdNewPct = document.createElement("td"); tdNewPct.textContent = fmtPct(newCatPct); tr.appendChild(tdNewPct);
        tbody.appendChild(tr);
      });
      catTable.appendChild(tbody);
      var tfoot = document.createElement("tfoot");
      tfoot.innerHTML = "<tr><td>Total</td><td>" + Portfolio.fmtDollar(result.portfolioTotal) +
        "</td><td>100.0%</td><td>" + fmtPct(sum) + "</td><td>" +
        Portfolio.fmtDollar(amount) + "</td><td>" +
        Portfolio.fmtDollar(result.newTotal) + "</td><td>100.0%</td></tr>";
      catTable.appendChild(tfoot);
      contribOutputArea.appendChild(catTable);

      // Per-ticker table
      var tickTitle = document.createElement("div");
      tickTitle.className = "rebal-section-title";
      tickTitle.textContent = "By Ticker";
      contribOutputArea.appendChild(tickTitle);

      var tickTable = document.createElement("table");
      tickTable.className = "rebal-table";
      var thead2 = document.createElement("thead");
      thead2.innerHTML = "<tr><th>Ticker</th><th>Current Value</th><th>Current %</th>" +
        "<th>Buy / Sell</th><th>New Value</th><th>New %</th></tr>";
      tickTable.appendChild(thead2);
      var tbody2 = document.createElement("tbody");
      result.tickers.forEach(function (t) {
        if (t.currentValue <= 0 && t.contribution === null) return;
        var buy = t.contribution !== null ? t.contribution : 0;
        var newTickerValue = t.currentValue + buy;
        var newTickerPct = result.newTotal > 0 ? (newTickerValue / result.newTotal) * 100 : 0;
        var tr = document.createElement("tr");
        var tdSym = document.createElement("td"); tdSym.textContent = t.symbol; tr.appendChild(tdSym);
        var tdVal = document.createElement("td"); tdVal.innerHTML = Portfolio.fmtDollar(t.currentValue); tr.appendChild(tdVal);
        var tdPct = document.createElement("td"); tdPct.textContent = fmtPct(t.currentPct); tr.appendChild(tdPct);
        var tdBuy = document.createElement("td");
        if (t.contribution === null) {
          tdBuy.className = "rebal-dash";
          tdBuy.textContent = "\u2014";
        } else {
          tdBuy.className = t.contribution > 0.005 ? "rebal-buy"
            : t.contribution < -0.005 ? "rebal-sell"
            : "rebal-zero";
          tdBuy.innerHTML = Portfolio.fmtDollar(t.contribution);
        }
        tr.appendChild(tdBuy);
        var tdNewVal = document.createElement("td"); tdNewVal.innerHTML = Portfolio.fmtDollar(newTickerValue); tr.appendChild(tdNewVal);
        var tdNewPct = document.createElement("td"); tdNewPct.textContent = fmtPct(newTickerPct); tr.appendChild(tdNewPct);
        tbody2.appendChild(tr);
      });
      tickTable.appendChild(tbody2);
      contribOutputArea.appendChild(tickTable);
    }

    // Wire all inputs
    cats.forEach(function (rc) {
      inputs[rc.name].addEventListener("input", function () {
        renderRebal();
        renderContrib();
      });
    });
    amountInput.addEventListener("input", renderContrib);

    renderRebal();
    renderContrib();
  }

  exports.computeRebalancing = computeRebalancing;
  exports.computeContributions = computeContributions;
  exports.buildToolsPanel = buildToolsPanel;

})(typeof module !== "undefined" ? module.exports : (window.Portfolio = window.Portfolio || {}));
