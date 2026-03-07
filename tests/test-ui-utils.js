const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { localDateString, tableArrowNav, historyDeltaStyle } = require("../app/js/ui-utils.js");

// ---------------------------------------------------------------------------
// Minimal DOM mocks for tableArrowNav
// ---------------------------------------------------------------------------

function makeInput(tag) {
  tag = tag || "INPUT";
  const el = { tagName: tag, focused: false };
  el.focus = function () { el.focused = true; };
  // closest() is set by makeTd/makeTr
  el.closest = function (sel) {
    if (sel === "td") return el._td || null;
    if (sel === "tr") return el._tr || null;
    return null;
  };
  return el;
}

function makeTd(input) {
  const td = { tagName: "TD", _input: input || null };
  td.querySelector = function () { return td._input; };
  if (input) {
    input._td = td;
  }
  return td;
}

function makeTr(cells) {
  const tr = { tagName: "TR", _cells: cells };
  tr.querySelectorAll = function () { return cells.slice(); };
  for (const cell of cells) {
    cell._tr = tr;
    if (cell._input) cell._input._tr = tr;
  }
  return tr;
}

function makeTbody(rows) {
  const tbody = { tagName: "TBODY" };
  tbody.querySelectorAll = function () { return rows.slice(); };
  return tbody;
}

function makeEvent(key, target) {
  return {
    key,
    target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}

// Build a 3-column × 3-row table. Returns { tbody, rows, inputs }
// inputs[row][col] — null for col 2 (simulates the delete button cell)
function makeTable() {
  const inputs = [];
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const rowInputs = [makeInput(), makeInput(), null]; // col 2 has no input
    const cells = rowInputs.map((inp) => makeTd(inp));
    const tr = makeTr(cells);
    inputs.push(rowInputs);
    rows.push(tr);
  }
  const tbody = makeTbody(rows);
  return { tbody, rows, inputs };
}

// ---------------------------------------------------------------------------
// localDateString
// ---------------------------------------------------------------------------

describe("localDateString", () => {
  it("returns a string matching YYYY-MM-DD", () => {
    assert.match(localDateString(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("matches today in local timezone", () => {
    const d = new Date();
    const expected =
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0");
    assert.equal(localDateString(), expected);
  });

  it("month is zero-padded", () => {
    // Result must always have a two-digit month segment
    const parts = localDateString().split("-");
    assert.equal(parts[1].length, 2);
  });

  it("day is zero-padded", () => {
    const parts = localDateString().split("-");
    assert.equal(parts[2].length, 2);
  });
});

// ---------------------------------------------------------------------------
// tableArrowNav
// ---------------------------------------------------------------------------

describe("tableArrowNav — ignores irrelevant events", () => {
  it("ignores non-arrow keys", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("Enter", inputs[0][0]);
    tableArrowNav(e, tbody);
    assert.ok(!e.defaultPrevented);
    assert.ok(!inputs[0][1].focused);
  });

  it("ignores events from non-input elements", () => {
    const { tbody, rows } = makeTable();
    // Simulate a button element in the td
    const btn = { tagName: "BUTTON" };
    const e = makeEvent("ArrowRight", btn);
    tableArrowNav(e, tbody);
    assert.ok(!e.defaultPrevented);
  });

  it("accepts SELECT elements", () => {
    const sel = makeInput("SELECT");
    const td = makeTd(sel);
    const inp2 = makeInput();
    const td2 = makeTd(inp2);
    const tr = makeTr([td, td2]);
    const tbody = makeTbody([tr]);
    const e = makeEvent("ArrowRight", sel);
    tableArrowNav(e, tbody);
    assert.ok(inp2.focused);
    assert.ok(e.defaultPrevented);
  });
});

describe("tableArrowNav — left/right navigation", () => {
  it("ArrowRight moves to the next input in the row", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowRight", inputs[0][0]);
    tableArrowNav(e, tbody);
    assert.ok(inputs[0][1].focused, "second input should be focused");
    assert.ok(e.defaultPrevented);
  });

  it("ArrowLeft moves to the previous input in the row", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowLeft", inputs[0][1]);
    tableArrowNav(e, tbody);
    assert.ok(inputs[0][0].focused, "first input should be focused");
    assert.ok(e.defaultPrevented);
  });

  it("ArrowRight skips cells with no input", () => {
    // col 2 has no input; pressing Right from col 1 should not focus anything
    // (there's nothing beyond col 2)
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowRight", inputs[0][1]);
    tableArrowNav(e, tbody);
    assert.ok(!e.defaultPrevented, "no target found, no preventDefault");
  });

  it("ArrowLeft does nothing when already at the first column", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowLeft", inputs[0][0]);
    tableArrowNav(e, tbody);
    assert.ok(!e.defaultPrevented);
  });

  it("ArrowRight does nothing when already at the last focusable column", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowRight", inputs[0][1]);
    tableArrowNav(e, tbody);
    assert.ok(!e.defaultPrevented);
  });
});

describe("tableArrowNav — up/down navigation", () => {
  it("ArrowDown moves to the same column in the next row", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowDown", inputs[0][0]);
    tableArrowNav(e, tbody);
    assert.ok(inputs[1][0].focused, "next row, same column");
    assert.ok(e.defaultPrevented);
  });

  it("ArrowUp moves to the same column in the previous row", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowUp", inputs[1][0]);
    tableArrowNav(e, tbody);
    assert.ok(inputs[0][0].focused, "previous row, same column");
    assert.ok(e.defaultPrevented);
  });

  it("ArrowDown does nothing on the last row", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowDown", inputs[2][0]);
    tableArrowNav(e, tbody);
    assert.ok(!e.defaultPrevented);
  });

  it("ArrowUp does nothing on the first row", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowUp", inputs[0][0]);
    tableArrowNav(e, tbody);
    assert.ok(!e.defaultPrevented);
  });

  it("ArrowDown stays in correct column on multi-row table", () => {
    const { tbody, inputs } = makeTable();
    const e = makeEvent("ArrowDown", inputs[0][1]);
    tableArrowNav(e, tbody);
    assert.ok(inputs[1][1].focused, "row 1, col 1");
    assert.ok(e.defaultPrevented);
  });

  it("ArrowDown skips to next row even when target column has no input", () => {
    const { tbody, inputs } = makeTable();
    // Navigate down from col 2 (which has no input in any row) — nothing happens
    const noInputTd = makeTd(null);
    noInputTd._tr = tbody.querySelectorAll()[0];
    noInputTd._tr._cells.push(noInputTd);
    // Use a fake input in col 2 of row 0 so we can trigger the event
    const fakeInput = makeInput();
    fakeInput._td = noInputTd;
    fakeInput._tr = noInputTd._tr;
    noInputTd._input = fakeInput;
    const e = makeEvent("ArrowDown", fakeInput);
    tableArrowNav(e, tbody);
    // col index is 2, row 1 col 2 has no input → no focus, no preventDefault
    assert.ok(!e.defaultPrevented);
  });
});

// ---------------------------------------------------------------------------
// historyDeltaStyle
// ---------------------------------------------------------------------------

describe("historyDeltaStyle — background color", () => {
  it("returns pure white when there is no change", () => {
    const s = historyDeltaStyle(100, 100);
    assert.equal(s.background, "rgb(255,255,255)");
  });

  it("returns full-intensity green at >=2% gain", () => {
    const s = historyDeltaStyle(110, 100); // +10%
    assert.equal(s.background, "rgb(198,239,198)");
  });

  it("returns full-intensity red at >=2% loss", () => {
    const s = historyDeltaStyle(90, 100); // -10%
    assert.equal(s.background, "rgb(254,202,202)");
  });

  it("returns an intermediate green for a small gain", () => {
    // +1% → intensity = 0.5
    const s = historyDeltaStyle(101, 100);
    // r = 255 - 0.5*(255-198) = 255 - 28.5 = 226 (rounded)
    // g = 255 - 0.5*(255-239) = 255 - 8 = 247
    // b = 255 - 0.5*(255-198) = 226
    assert.equal(s.background, "rgb(227,247,227)");
  });

  it("returns an intermediate red for a small loss", () => {
    // -1% → intensity = 0.5
    const s = historyDeltaStyle(99, 100);
    // r = 255 - 0.5*(255-254) = 254 (rounded)
    // g = 255 - 0.5*(255-202) = 228 (rounded) → 255-26.5 = 228
    // b = 255 - 0.5*(255-202) = 228
    assert.equal(s.background, "rgb(255,229,229)");
  });

  it("returns white when prevVal is zero (pct treated as 0)", () => {
    const s = historyDeltaStyle(100, 0);
    assert.equal(s.background, "rgb(255,255,255)");
  });

  it("clamps at full intensity beyond 2%", () => {
    const at2pct = historyDeltaStyle(102, 100);
    const at5pct = historyDeltaStyle(105, 100);
    assert.equal(at2pct.background, at5pct.background);
  });
});

describe("historyDeltaStyle — title text", () => {
  it("formats a positive delta with + prefix", () => {
    const s = historyDeltaStyle(110, 100);
    assert.ok(s.title.startsWith("+$"), `title should start with +$, got: ${s.title}`);
  });

  it("formats a negative delta with - prefix", () => {
    const s = historyDeltaStyle(90, 100);
    assert.ok(s.title.startsWith("-$"), `title should start with -$, got: ${s.title}`);
  });

  it("includes the absolute dollar amount", () => {
    const s = historyDeltaStyle(110, 100);
    assert.ok(s.title.includes("10.00"), `expected 10.00 in title, got: ${s.title}`);
  });

  it("includes the percentage", () => {
    const s = historyDeltaStyle(110, 100);
    assert.ok(s.title.includes("+10.00%"), `expected +10.00% in title, got: ${s.title}`);
  });

  it("shows negative percentage for a loss", () => {
    const s = historyDeltaStyle(90, 100);
    assert.ok(s.title.includes("-10.00%"), `expected -10.00% in title, got: ${s.title}`);
  });

  it("shows zero change as +$0.00 and +0.00%", () => {
    const s = historyDeltaStyle(100, 100);
    assert.ok(s.title.includes("+$0.00"), `expected +$0.00 in title, got: ${s.title}`);
    assert.ok(s.title.includes("+0.00%"), `expected +0.00% in title, got: ${s.title}`);
  });

  it("uses comma separators for large amounts", () => {
    const s = historyDeltaStyle(11000, 10000); // +$1,000.00
    assert.ok(s.title.includes("1,000.00"), `expected 1,000.00 in title, got: ${s.title}`);
  });
});
