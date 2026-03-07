(function (exports) {
  "use strict";

  // Returns today's date as YYYY-MM-DD using the browser's local timezone.
  function localDateString() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  // Arrow-key navigation for editable tables.
  // Left/Right move between focusable cells in the same row.
  // Up/Down move to the same column index in the adjacent row.
  function tableArrowNav(e, tbody) {
    var key = e.key;
    if (key !== "ArrowUp" && key !== "ArrowDown" && key !== "ArrowLeft" && key !== "ArrowRight") return;

    var target = e.target;
    // Only navigate from inputs and selects
    if (target.tagName !== "INPUT" && target.tagName !== "SELECT") return;

    var td = target.closest("td");
    var tr = target.closest("tr");
    if (!td || !tr) return;

    // Collect focusable cells in the current row
    var cells = Array.from(tr.querySelectorAll("td"));
    var focusable = cells.map(function (c) { return c.querySelector("input, select"); });
    var colIdx = cells.indexOf(td);

    if (key === "ArrowLeft" || key === "ArrowRight") {
      var delta = key === "ArrowLeft" ? -1 : 1;
      for (var ci = colIdx + delta; ci >= 0 && ci < focusable.length; ci += delta) {
        if (focusable[ci]) {
          e.preventDefault();
          focusable[ci].focus();
          return;
        }
      }
    } else {
      // Up / Down
      var allRows = Array.from(tbody.querySelectorAll("tr"));
      var rowIdx = allRows.indexOf(tr);
      var targetRowIdx = key === "ArrowUp" ? rowIdx - 1 : rowIdx + 1;
      if (targetRowIdx < 0 || targetRowIdx >= allRows.length) return;
      var targetRow = allRows[targetRowIdx];
      var targetCells = Array.from(targetRow.querySelectorAll("td"));
      var targetEl = targetCells[colIdx] && targetCells[colIdx].querySelector("input, select");
      if (targetEl) {
        e.preventDefault();
        targetEl.focus();
      }
    }
  }

  // Compute the background color and tooltip text for a history table cell.
  // Returns { background: "rgb(...)", title: "+$1.23  (+1.00%)" }.
  // Intensity reaches full saturation at ±2% change.
  function historyDeltaStyle(val, prevVal) {
    var delta = val - prevVal;
    var pct = prevVal !== 0 ? delta / prevVal : 0;
    var intensity = Math.min(Math.abs(pct) / 0.02, 1);
    var r, g, b;
    if (delta >= 0) {
      // white → green
      r = Math.round(255 - intensity * (255 - 198));
      g = Math.round(255 - intensity * (255 - 239));
      b = Math.round(255 - intensity * (255 - 198));
    } else {
      // white → red
      r = Math.round(255 - intensity * (255 - 254));
      g = Math.round(255 - intensity * (255 - 202));
      b = Math.round(255 - intensity * (255 - 202));
    }
    var background = "rgb(" + r + "," + g + "," + b + ")";
    var sign = delta >= 0 ? "+" : "";
    var absFmt = (delta >= 0 ? "+$" : "-$") + Math.abs(delta).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    var relFmt = sign + (pct * 100).toFixed(2) + "%";
    return { background: background, title: absFmt + "  (" + relFmt + ")" };
  }

  exports.localDateString = localDateString;
  exports.tableArrowNav = tableArrowNav;
  exports.historyDeltaStyle = historyDeltaStyle;
})(typeof module !== "undefined" && module.exports
  ? module.exports
  : (window.Portfolio = window.Portfolio || {}));
