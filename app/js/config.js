(function (exports) {
  "use strict";

  /**
   * Parse a raw config object into normalized internal structures.
   *
   * Supports both the current and new config schema formats:
   *
   * Allocations:
   *   - Array format (original): [{ symbol, category, fraction (string|number) }]
   *   - Object format (new):     { "VTI": { "Category": 0.5 }, ... }
   *
   * Rebalancing:
   *   - Explicit section (original): rebalancing.categories + rebalancing.targets + rebalancing.tradeable
   *   - Inline targets (new): exposure.display[].target (number) + exposure.tradeable
   *
   * Types:
   *   - indent: accepts both "true" (string) and true (boolean)
   *   - fraction: accepts both "0.5" (string) and 0.5 (number)
   *   - target: accepts both "10" (string) and 10 (number)
   *
   * @param {object} cfg - Raw config object (from config.json)
   * @returns {object} Parsed config with normalized fields
   */
  function colorWithAlpha(color, alpha) {
    var c = color.trim();
    // Expand 3-digit hex to 6-digit
    if (/^#[0-9a-fA-F]{3}$/.test(c)) {
      c = "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
    }
    if (/^#[0-9a-fA-F]{6}$/.test(c)) {
      var r = parseInt(c.slice(1, 3), 16);
      var g = parseInt(c.slice(3, 5), 16);
      var b = parseInt(c.slice(5, 7), 16);
      return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
    }
    if (c.startsWith("rgb(") && c.endsWith(")")) {
      return "rgba(" + c.slice(4, -1) + "," + alpha + ")";
    }
    if (c.startsWith("rgba(") && c.endsWith(")")) {
      var parts = c.slice(5, -1).split(",");
      parts[3] = alpha;
      return "rgba(" + parts.join(",") + ")";
    }
    return c;
  }

  function parseConfig(cfg) {
    var result = {
      colors: null,
      exposureMap: null,
      exposureDisplay: null,
      symbolOrder: null,
      rebalancingConfig: null,
      marginLoanDisplay: null,
      capitalGainsMethod: null,
    };

    if (!cfg) return result;

    // chartColors is the canonical name; colors is accepted for backwards compatibility
    var rawColors = cfg.chartColors !== undefined ? cfg.chartColors : cfg.colors;
    if (Array.isArray(rawColors) && rawColors.length > 0) {
      result.colors = rawColors.map(function (c) {
        if (typeof c === "string") {
          return { stroke: c, fill: colorWithAlpha(c, 0.55) };
        }
        return c;
      });
    }

    if (cfg.exposure) {
      var allocs = cfg.exposure.allocations;
      var map = null;

      if (allocs && !Array.isArray(allocs) && typeof allocs === "object") {
        // New object format: { "VTI": { "Category": fraction }, ... }
        map = {};
        for (var sym in allocs) {
          map[sym] = {};
          var catMap = allocs[sym];
          for (var cat in catMap) {
            map[sym][cat] = parseFloat(catMap[cat]);
          }
        }
      } else if (Array.isArray(allocs)) {
        // Original array format: [{ symbol, category, fraction }]
        map = {};
        for (var i = 0; i < allocs.length; i++) {
          var a = allocs[i];
          if (!map[a.symbol]) map[a.symbol] = {};
          map[a.symbol][a.category] = parseFloat(a.fraction);
        }
      }

      if (map && Object.keys(map).length > 0) {
        result.exposureMap = map;
      }

      if (Array.isArray(cfg.exposure.display) && cfg.exposure.display.length > 0) {
        result.exposureDisplay = cfg.exposure.display;
      }
    }

    if (Array.isArray(cfg.symbolOrder)) result.symbolOrder = cfg.symbolOrder;

    // Rebalancing: explicit section takes precedence over inline display targets
    if (cfg.rebalancing && (Array.isArray(cfg.rebalancing.categories) || cfg.rebalancing.targets)) {
      var rebal = { categories: [], targets: {}, tradeable: null };
      if (Array.isArray(cfg.rebalancing.categories)) {
        rebal.categories = cfg.rebalancing.categories;
      }
      if (cfg.rebalancing.targets && typeof cfg.rebalancing.targets === "object") {
        var rawTargets = cfg.rebalancing.targets;
        for (var tk in rawTargets) rebal.targets[tk] = parseFloat(rawTargets[tk]);
      }
      if (Array.isArray(cfg.rebalancing.tradeable)) {
        rebal.tradeable = cfg.rebalancing.tradeable;
      }
      result.rebalancingConfig = rebal;
    } else if (result.exposureDisplay) {
      // New format: derive rebalancing from display rows that have a target field
      var cats = [];
      var targets = {};
      var hasTargets = false;
      for (var di = 0; di < result.exposureDisplay.length; di++) {
        var d = result.exposureDisplay[di];
        if (d.target != null) {
          hasTargets = true;
          var entry = { name: d.name };
          if (d.subcategories) entry.subcategories = d.subcategories;
          else if (d.category) entry.category = d.category;
          cats.push(entry);
          targets[d.name] = parseFloat(d.target);
        }
      }
      if (hasTargets) {
        var rebal2 = { categories: cats, targets: targets, tradeable: null };
        // New format: tradeable lives under exposure
        if (Array.isArray(cfg.exposure.tradeable)) {
          rebal2.tradeable = cfg.exposure.tradeable;
        }
        result.rebalancingConfig = rebal2;
      }
    }

    if (cfg.marginLoan && cfg.marginLoan.chartDisplay === "proportional") {
      result.marginLoanDisplay = "proportional";
    }

    // defaultMethod is the canonical name; method is accepted for backwards compatibility
    if (cfg.capitalGains) {
      var cgMethod = cfg.capitalGains.defaultMethod !== undefined
        ? cfg.capitalGains.defaultMethod
        : cfg.capitalGains.method;
      if (cgMethod === "FIFO") result.capitalGainsMethod = "FIFO";
    }

    return result;
  }

  exports.parseConfig = parseConfig;

})(typeof module !== "undefined" ? module.exports : (window.Portfolio = window.Portfolio || {}));
