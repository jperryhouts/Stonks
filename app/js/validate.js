(function (exports) {
  "use strict";

  /**
   * Validate loaded portfolio data and return an array of notification items.
   *
   * @param {Array}  trades     - trade array
   * @param {Object} gainsData  - result of computeGains()
   * @param {Object} retirement - retirement.json contents (may be null)
   * @param {Array}  market     - market.json rows [{timestamp, ...prices}]
   * @param {Object} [config]   - parsed config fields: { exposureMap, symbolOrder }
   * @returns {Array} items - [{level: 'warning'|'error', text: string}]
   */
  function validateData(trades, gainsData, retirement, market, config) {
    var items = [];

    // Check for gains cost-basis warnings (insufficient shares / lot not found)
    if (gainsData && gainsData.realized) {
      var warnCount = 0;
      for (var ri = 0; ri < gainsData.realized.length; ri++) {
        if (gainsData.realized[ri].warning) warnCount++;
      }
      if (warnCount > 0) {
        items.push({
          level: "warning",
          text: warnCount + " trade" + (warnCount === 1 ? "" : "s") +
                " have cost basis gaps \u2014 see Gains tab for details",
        });
      }
    }

    // Check retirement proxy coverage
    if (retirement && retirement.accounts && market && market.length > 0) {
      var marketKeys = market[0];
      for (var ai = 0; ai < retirement.accounts.length; ai++) {
        var acct = retirement.accounts[ai];
        var proxy = acct.proxy || "VTI";
        if (!(proxy in marketKeys)) {
          items.push({
            level: "warning",
            text: "Retirement account \u201c" + acct.name + "\u201d: proxy " + proxy +
                  " has no market data \u2014 values are estimated without market scaling",
          });
        }
      }
    }

    // Config checks
    if (config) {
      // Build the set of known symbols from all data sources
      var knownSymbols = {};
      if (market && market.length > 0) {
        for (var mk in market[0]) {
          if (mk !== "timestamp") knownSymbols[mk] = true;
        }
      }
      if (trades) {
        for (var ti = 0; ti < trades.length; ti++) {
          if (trades[ti].symbol) knownSymbols[trades[ti].symbol] = true;
        }
      }
      if (retirement && retirement.accounts) {
        for (var ki = 0; ki < retirement.accounts.length; ki++) {
          if (retirement.accounts[ki].name) knownSymbols[retirement.accounts[ki].name] = true;
        }
      }
      if (config.assets) {
        for (var xi = 0; xi < config.assets.length; xi++) {
          if (config.assets[xi].name) knownSymbols[config.assets[xi].name] = true;
        }
      }

      // Check allocations for unknown tickers and fractions that don't sum to 1
      var exposureMap = config.exposureMap;
      if (exposureMap && typeof exposureMap === "object") {
        for (var sym in exposureMap) {
          if (!knownSymbols[sym]) {
            items.push({
              level: "warning",
              text: "config.json: allocation symbol \u201c" + sym + "\u201d not found in trades, market data, or retirement accounts",
            });
          }
          var catMap = exposureMap[sym];
          var sum = 0;
          for (var cat in catMap) sum += catMap[cat];
          if (!isFinite(sum) || Math.abs(sum - 1.0) > 0.01) {
            items.push({
              level: "warning",
              text: "config.json: allocation fractions for \u201c" + sym + "\u201d sum to " +
                    (isFinite(sum) ? sum.toFixed(4) : "invalid") +
                    " (expected 1.0)",
            });
          }
        }
      }

      // Check symbolOrder for entries not matching any known symbol
      var symbolOrder = config.symbolOrder;
      if (Array.isArray(symbolOrder)) {
        for (var si = 0; si < symbolOrder.length; si++) {
          if (!knownSymbols[symbolOrder[si]]) {
            items.push({
              level: "warning",
              text: "config.json: symbolOrder entry \u201c" + symbolOrder[si] + "\u201d not found in trades, market data, or retirement accounts",
            });
          }
        }
      }
    }

    return items;
  }

  exports.validateData = validateData;
})(typeof module !== "undefined" && module.exports
  ? module.exports
  : (window.Portfolio = window.Portfolio || {}));
