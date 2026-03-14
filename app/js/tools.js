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
   * @returns {{ portfolioTotal, categories, tickers }}
   *
   * categories: [{ name, currentValue, currentPct, targetPct, targetValue, buySell }]
   * tickers:    [{ symbol, currentValue, currentPct, impliedTarget, buySell }]
   *   impliedTarget/buySell are null for unmapped or non-tradeable symbols
   */
  function computeRebalancing(fullData, exposureMap, rebalCats, targets, options) {
    var tradeable = (options && Array.isArray(options.tradeable)) ? options.tradeable : null;

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
      if (!exposureMap[symbol]) return null; // only show mapped symbols

      var currentValue = values[symbol] || 0;
      var currentPct = portfolioTotal > 0 ? (currentValue / portfolioTotal) * 100 : 0;

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
   * @param {object}       [options]       - optional config (tradeable)
   * @returns {{ portfolioTotal, newTotal, categories, tickers }}
   *
   * categories: [{ name, currentValue, currentPct, targetPct, contribution }]
   * tickers:    [{ symbol, currentValue, currentPct, impliedTarget, contribution }]
   *   impliedTarget/contribution are null for unmapped or non-tradeable symbols
   */
  function computeContributions(fullData, exposureMap, rebalCats, targets, amount, options) {
    var tradeable = (options && Array.isArray(options.tradeable)) ? options.tradeable : null;

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
        totalCurrent += values[sym] || 0;
        eligibleSyms.push(sym);
      });
      eligibleSyms.forEach(function (sym) {
        var w = totalCurrent > 0 ? (values[sym] || 0) / totalCurrent : 1 / eligibleSyms.length;
        contributions[sym] = w * amount;
      });
    }

    // Build ticker output
    var tickers = (fullData.symbols || []).map(function (symbol) {
      if (!exposureMap[symbol]) return null; // only show mapped symbols
      var currentValue = values[symbol] || 0;
      var currentPct = portfolioTotal > 0 ? (currentValue / portfolioTotal) * 100 : 0;

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
  // DOM builder
  // ---------------------------------------------------------------------------

  function buildToolsPanel(fullData, exposureMap, rebalancingConfig, exposureDisplay) {
    var container = document.getElementById("panel-tools");
    if (!container) return;
    container.innerHTML = "";

    // Compute exposure for donut + merged table values
    var exp = computeExposure(fullData);
    var chartRows = [];
    var barColors = {};
    if (exp) {
      for (var di = 0; di < exposureDisplay.length; di++) {
        var d = exposureDisplay[di];
        var dv;
        if (d.subcategories) {
          var parts = d.subcategories.split(",");
          dv = 0;
          for (var si = 0; si < parts.length; si++) dv += exp.buckets[parts[si].trim()] || 0;
        } else {
          dv = exp.buckets[d.category || d.name] || 0;
        }
        chartRows.push({ name: d.name, value: dv,
                         indent: d.indent === true || d.indent === "true",
                         group: !!d.subcategories });
        barColors[d.name] = d.color || "#888";
      }
    }

    // Mutable row lookup populated by renderCategoryTable; used by donut hover
    var rebalTrByName = {};
    function onHighlightRebal(name) {
      for (var n in rebalTrByName) {
        rebalTrByName[n].classList.toggle("highlighted", n === name);
      }
    }

    var cats = rebalancingConfig.categories || [];
    var defaultTargets = rebalancingConfig.targets || {};

    // Live target state shared across all sub-tabs
    var liveTargets = {};
    cats.forEach(function (rc) {
      liveTargets[rc.name] = defaultTargets[rc.name] || 0;
    });

    // --- Shared section: donut chart + category table ---
    var sharedSection = document.createElement("div");
    sharedSection.className = "tools-shared-section";

    if (exp && exp.total > 0) {
      var chartWrap = document.createElement("div");
      chartWrap.id = "tools-chart-wrap";
      drawExposureChart(chartWrap, chartRows, barColors, exp.total, onHighlightRebal);
      sharedSection.appendChild(chartWrap);
    }

    var sharedOutputArea = document.createElement("div");
    sharedSection.appendChild(sharedOutputArea);
    container.appendChild(sharedSection);

    // --- Sub-tab bar ---
    var subtabBar = document.createElement("div");
    subtabBar.className = "tools-subtabs";

    var rebalBtn = document.createElement("button");
    rebalBtn.className = "tools-subtab active";
    rebalBtn.textContent = "Rebalance";

    var investBtn = document.createElement("button");
    investBtn.className = "tools-subtab";
    investBtn.textContent = "Invest";

    var withdrawBtn = document.createElement("button");
    withdrawBtn.className = "tools-subtab";
    withdrawBtn.textContent = "Withdraw";

    subtabBar.appendChild(rebalBtn);
    subtabBar.appendChild(investBtn);
    subtabBar.appendChild(withdrawBtn);
    container.appendChild(subtabBar);

    // --- Invest amount row (hidden until Invest tab is active) ---
    var investAmountRow = document.createElement("div");
    investAmountRow.className = "contrib-amount-row hidden";
    var investAmountLabel = document.createElement("label");
    investAmountLabel.className = "contrib-amount-label";
    investAmountLabel.textContent = "Amount to invest";
    var investAmountWrap = document.createElement("div");
    investAmountWrap.className = "contrib-amount-input-wrap";
    var investDollar = document.createElement("span");
    investDollar.className = "contrib-dollar";
    investDollar.textContent = "$";
    var investAmountInput = document.createElement("input");
    investAmountInput.type = "number";
    investAmountInput.className = "contrib-amount-input";
    investAmountInput.step = "100";
    investAmountInput.min = "0";
    investAmountInput.placeholder = "0";
    investAmountInput.value = "";
    investAmountWrap.appendChild(investDollar);
    investAmountWrap.appendChild(investAmountInput);
    investAmountRow.appendChild(investAmountLabel);
    investAmountRow.appendChild(investAmountWrap);
    container.appendChild(investAmountRow);

    // --- Withdraw amount row (hidden until Withdraw tab is active) ---
    var withdrawAmountRow = document.createElement("div");
    withdrawAmountRow.className = "contrib-amount-row hidden";
    var withdrawAmountLabel = document.createElement("label");
    withdrawAmountLabel.className = "contrib-amount-label";
    withdrawAmountLabel.textContent = "Amount to withdraw";
    var withdrawAmountWrap = document.createElement("div");
    withdrawAmountWrap.className = "contrib-amount-input-wrap";
    var withdrawDollar = document.createElement("span");
    withdrawDollar.className = "contrib-dollar";
    withdrawDollar.textContent = "$";
    var withdrawAmountInput = document.createElement("input");
    withdrawAmountInput.type = "number";
    withdrawAmountInput.className = "contrib-amount-input";
    withdrawAmountInput.step = "100";
    withdrawAmountInput.min = "0";
    withdrawAmountInput.placeholder = "0";
    withdrawAmountInput.value = "";
    withdrawAmountWrap.appendChild(withdrawDollar);
    withdrawAmountWrap.appendChild(withdrawAmountInput);
    withdrawAmountRow.appendChild(withdrawAmountLabel);
    withdrawAmountRow.appendChild(withdrawAmountWrap);
    container.appendChild(withdrawAmountRow);

    // --- Trades output area (single shared div) ---
    var tradesOutputArea = document.createElement("div");
    container.appendChild(tradesOutputArea);

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

    // --- Active panel tracking ---
    var activePanel = "rebalance";

    // --- Category table (shared, always visible, mode-adaptive) ---
    function renderCategoryTable() {
      var contribAmount = 0;
      if (activePanel === "invest") contribAmount = parseFloat(investAmountInput.value) || 0;
      if (activePanel === "withdraw") contribAmount = -(parseFloat(withdrawAmountInput.value) || 0);
      var useContribMode = activePanel !== "rebalance";

      var sum = cats.reduce(function (s, rc) { return s + liveTargets[rc.name]; }, 0);

      var rebalResult = computeRebalancing(fullData, exposureMap, cats, liveTargets, {
        tradeable: rebalancingConfig.tradeable || null,
      });
      var contribResult = useContribMode
        ? computeContributions(fullData, exposureMap, cats, liveTargets, contribAmount, {
            tradeable: rebalancingConfig.tradeable || null,
          })
        : null;

      sharedOutputArea.innerHTML = "";

      // Validation hint
      if (Math.abs(sum - 100) > 0.01) {
        var hint = document.createElement("div");
        hint.className = "rebal-validation";
        hint.textContent = "Targets sum to " + sum.toFixed(1) + "% — adjust to 100% for a balanced result";
        sharedOutputArea.appendChild(hint);
      }

      // Category table with inline target inputs
      var catTable = document.createElement("table");
      catTable.className = "rebal-table";
      var thead = document.createElement("thead");
      if (useContribMode) {
        var col5Header = activePanel === "invest" ? "Buy" : "Sell";
        thead.innerHTML = "<tr><th>Category</th><th>Value</th><th>%</th>" +
          "<th>Target %</th><th>" + col5Header + "</th><th>New %</th></tr>";
      } else {
        thead.innerHTML = "<tr><th>Category</th><th>Value</th><th>%</th>" +
          "<th>Target %</th><th>Difference</th><th>Over / Under</th></tr>";
      }
      catTable.appendChild(thead);

      rebalTrByName = {};
      var catByName = {};
      rebalResult.categories.forEach(function(c) { catByName[c.name] = c; });
      var contribByName = {};
      if (contribResult) {
        contribResult.categories.forEach(function(c) { contribByName[c.name] = c; });
      }

      var expTotal = exp ? exp.total : 0;
      var inlineInputs = {};
      var tbody = document.createElement("tbody");
      for (var rdi = 0; rdi < exposureDisplay.length; rdi++) {
        var rd = exposureDisplay[rdi];
        var rdv;
        if (rd.subcategories) {
          var rdparts = rd.subcategories.split(",");
          rdv = 0;
          for (var rsi = 0; rsi < rdparts.length; rsi++) rdv += (exp ? exp.buckets[rdparts[rsi].trim()] : 0) || 0;
        } else {
          rdv = exp ? (exp.buckets[rd.category || rd.name] || 0) : 0;
        }
        var rdPct = expTotal > 0 ? (rdv / expTotal) * 100 : 0;
        var rcat = catByName[rd.name];

        var tr = document.createElement("tr");
        if (rd.indent === true || rd.indent === "true") tr.className = "indent";
        rebalTrByName[rd.name] = tr;

        var tdName = document.createElement("td");
        var swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.backgroundColor = barColors[rd.name] || "#888";
        if (rd.indent === true || rd.indent === "true") swatch.style.opacity = "0.7";
        tdName.appendChild(swatch);
        tdName.appendChild(document.createTextNode(rd.name));
        if (rd.subcategories) tdName.style.fontWeight = "600";
        tr.appendChild(tdName);

        var tdVal = document.createElement("td"); tdVal.innerHTML = Portfolio.fmtDollar(rdv); tr.appendChild(tdVal);
        var tdPct = document.createElement("td"); tdPct.textContent = rdPct.toFixed(1) + "%"; tr.appendChild(tdPct);

        var tdTgt = document.createElement("td");
        if (rcat) {
          var inputWrap = document.createElement("div");
          inputWrap.className = "rebal-target-input-wrap";
          var inp = document.createElement("input");
          inp.type = "number";
          inp.className = "rebal-target-input";
          inp.min = "0"; inp.max = "100"; inp.step = "1";
          inp.value = String(liveTargets[rd.name] != null ? liveTargets[rd.name] : rcat.targetPct);
          var pctSpan = document.createElement("span");
          pctSpan.className = "rebal-target-pct";
          pctSpan.textContent = "%";
          inputWrap.appendChild(inp);
          inputWrap.appendChild(pctSpan);
          tdTgt.appendChild(inputWrap);
          inlineInputs[rd.name] = inp;
        } else { tdTgt.className = "rebal-dash"; tdTgt.textContent = "\u2014"; }
        tr.appendChild(tdTgt);

        if (useContribMode) {
          var ccat = contribByName[rd.name];
          var tdC5 = document.createElement("td");
          var tdC6 = document.createElement("td");
          if (ccat) {
            var contrib = ccat.contribution;
            var newCatVal = ccat.currentValue + contrib;
            var newCatPct = contribResult.newTotal > 0 ? (newCatVal / contribResult.newTotal) * 100 : 0;
            if (activePanel === "invest") {
              tdC5.className = contrib > 0.005 ? "rebal-buy" : "rebal-zero";
              tdC5.innerHTML = Portfolio.fmtDollar(contrib);
            } else {
              tdC5.className = contrib < -0.005 ? "rebal-sell" : "rebal-zero";
              tdC5.innerHTML = Portfolio.fmtDollar(Math.abs(contrib));
            }
            tdC6.textContent = fmtPct(newCatPct);
          } else {
            tdC5.className = "rebal-dash"; tdC5.textContent = "\u2014";
            tdC6.className = "rebal-dash"; tdC6.textContent = "\u2014";
          }
          tr.appendChild(tdC5);
          tr.appendChild(tdC6);
        } else {
          var tdDiff = document.createElement("td");
          if (rcat) {
            var rdiff = rcat.currentPct - rcat.targetPct;
            tdDiff.className = rdiff > 0.05 ? "rebal-sell" : rdiff < -0.05 ? "rebal-buy" : "rebal-zero";
            tdDiff.textContent = (rdiff >= 0 ? "+" : "") + fmtPct(rdiff);
          } else { tdDiff.className = "rebal-dash"; tdDiff.textContent = "\u2014"; }
          tr.appendChild(tdDiff);

          var tdBs = document.createElement("td");
          if (rcat) {
            var rbs = fmtOverUnder(rcat.buySell);
            tdBs.className = rbs.cls; tdBs.textContent = rbs.text;
          } else { tdBs.className = "rebal-dash"; tdBs.textContent = "\u2014"; }
          tr.appendChild(tdBs);
        }

        tbody.appendChild(tr);
      }
      catTable.appendChild(tbody);
      var tfoot = document.createElement("tfoot");
      if (useContribMode) {
        tfoot.innerHTML = "<tr><td>Total</td><td>" + Portfolio.fmtDollar(expTotal) +
          "</td><td>100.0%</td><td></td><td>" +
          Portfolio.fmtDollar(Math.abs(contribAmount)) + "</td><td>100.0%</td></tr>";
      } else {
        tfoot.innerHTML = "<tr><td>Total</td><td>" + Portfolio.fmtDollar(expTotal) +
          "</td><td>100.0%</td><td></td><td></td><td></td></tr>";
      }
      catTable.appendChild(tfoot);
      var catWrap = document.createElement("div");
      catWrap.className = "wide-table-scroll";
      catWrap.appendChild(catTable);
      sharedOutputArea.appendChild(catWrap);

      // Wire inline target inputs
      for (var iname in inlineInputs) {
        (function(name, input) {
          input.addEventListener("change", function() {
            liveTargets[name] = parseFloat(input.value) || 0;
            renderActivePanel();
          });
        })(iname, inlineInputs[iname]);
      }
    }

    // --- Trades render (single function for all three modes) ---
    function renderTrades() {
      tradesOutputArea.innerHTML = "";
      var amount = 0;
      if (activePanel === "invest") amount = parseFloat(investAmountInput.value) || 0;
      if (activePanel === "withdraw") amount = -(parseFloat(withdrawAmountInput.value) || 0);
      var useContribMode = activePanel !== "rebalance";

      // Withdraw validation: warn if amount exceeds the total value of tradeable symbols
      if (activePanel === "withdraw" && amount < 0) {
        var latestValues = (fullData && fullData.chartData && fullData.chartData.length > 0)
          ? (fullData.chartData[fullData.chartData.length - 1].values || {})
          : {};
        var tradeableSyms = rebalancingConfig.tradeable || Object.keys(exposureMap);
        var tradeableTotal = 0;
        tradeableSyms.forEach(function (sym) { tradeableTotal += latestValues[sym] || 0; });
        if (-amount > tradeableTotal) {
          var warn = document.createElement("div");
          warn.className = "rebal-validation";
          warn.textContent = "Amount exceeds the total value of sellable assets (" +
            Portfolio.fmtDollar(tradeableTotal) + ")";
          tradesOutputArea.appendChild(warn);
        }
      }

      var title = document.createElement("div");
      title.className = "rebal-section-title";
      title.textContent = "Suggested Trades";
      tradesOutputArea.appendChild(title);

      if (!useContribMode) {
        // Rebalance-style table (also shown for Invest/Withdraw with no amount entered)
        var result = computeRebalancing(fullData, exposureMap, cats, liveTargets, {
          tradeable: rebalancingConfig.tradeable || null,
        });
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
        var tickWrap1 = document.createElement("div");
        tickWrap1.className = "wide-table-scroll";
        tickWrap1.appendChild(tickTable);
        tradesOutputArea.appendChild(tickWrap1);
      } else {
        // Contribution-style table (Invest or Withdraw with amount entered)
        var result = computeContributions(fullData, exposureMap, cats, liveTargets, amount, {
          tradeable: rebalancingConfig.tradeable || null,
        });
        var col5Header = activePanel === "invest" ? "Buy" : "Sell";
        var tickTable = document.createElement("table");
        tickTable.className = "rebal-table";
        var thead2 = document.createElement("thead");
        thead2.innerHTML = "<tr><th>Ticker</th><th>Current Value</th><th>Current %</th>" +
          "<th>" + col5Header + "</th><th>New Value</th><th>New %</th></tr>";
        tickTable.appendChild(thead2);
        var tbody2 = document.createElement("tbody");
        result.tickers.forEach(function (t) {
          if (t.currentValue <= 0 && t.contribution === null) return;
          var contrib = t.contribution !== null ? t.contribution : 0;
          var newTickerValue = t.currentValue + contrib;
          var newTickerPct = result.newTotal > 0 ? (newTickerValue / result.newTotal) * 100 : 0;
          var tr = document.createElement("tr");
          var tdSym = document.createElement("td"); tdSym.textContent = t.symbol; tr.appendChild(tdSym);
          var tdVal = document.createElement("td"); tdVal.innerHTML = Portfolio.fmtDollar(t.currentValue); tr.appendChild(tdVal);
          var tdPct = document.createElement("td"); tdPct.textContent = fmtPct(t.currentPct); tr.appendChild(tdPct);
          var tdContrib = document.createElement("td");
          if (t.contribution === null) {
            tdContrib.className = "rebal-dash";
            tdContrib.textContent = "\u2014";
          } else if (activePanel === "invest") {
            tdContrib.className = contrib > 0.005 ? "rebal-buy" : "rebal-zero";
            tdContrib.innerHTML = Portfolio.fmtDollar(contrib);
          } else {
            tdContrib.className = contrib < -0.005 ? "rebal-sell" : "rebal-zero";
            tdContrib.innerHTML = Portfolio.fmtDollar(Math.abs(contrib));
          }
          tr.appendChild(tdContrib);
          var tdNewVal = document.createElement("td"); tdNewVal.innerHTML = Portfolio.fmtDollar(newTickerValue); tr.appendChild(tdNewVal);
          var tdNewPct = document.createElement("td"); tdNewPct.textContent = fmtPct(newTickerPct); tr.appendChild(tdNewPct);
          tbody2.appendChild(tr);
        });
        tickTable.appendChild(tbody2);
        var tickWrap2 = document.createElement("div");
        tickWrap2.className = "wide-table-scroll";
        tickWrap2.appendChild(tickTable);
        tradesOutputArea.appendChild(tickWrap2);
      }
    }

    // --- Render both tables ---
    function renderActivePanel() {
      renderCategoryTable();
      renderTrades();
    }

    function showPanel(name) {
      activePanel = name;
      rebalBtn.classList.toggle("active", name === "rebalance");
      investBtn.classList.toggle("active", name === "invest");
      withdrawBtn.classList.toggle("active", name === "withdraw");
      investAmountRow.classList.toggle("hidden", name !== "invest");
      withdrawAmountRow.classList.toggle("hidden", name !== "withdraw");
      renderActivePanel();
    }

    // --- Sub-tab switching ---
    rebalBtn.addEventListener("click", function () { showPanel("rebalance"); });
    investBtn.addEventListener("click", function () { showPanel("invest"); });
    withdrawBtn.addEventListener("click", function () { showPanel("withdraw"); });

    // --- Amount input listeners ---
    investAmountInput.addEventListener("input", renderActivePanel);
    withdrawAmountInput.addEventListener("input", renderActivePanel);

    // --- Initial render ---
    renderActivePanel();
  }

  exports.computeRebalancing = computeRebalancing;
  exports.computeContributions = computeContributions;
  exports.buildToolsPanel = buildToolsPanel;

})(typeof module !== "undefined" ? module.exports : (window.Portfolio = window.Portfolio || {}));
