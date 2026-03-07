const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { csvToJson, prettyJson, validateTrades, normalizeTrades, getIP, serverLog, serverWarn } = require("../app/serve.js");

// ---------------------------------------------------------------------------
// csvToJson
// ---------------------------------------------------------------------------

describe("csvToJson", () => {
  it("returns empty array for empty string", () => {
    assert.deepEqual(csvToJson(""), []);
  });

  it("returns empty array for header-only CSV", () => {
    assert.deepEqual(csvToJson("timestamp,VTI,BND"), []);
  });

  it("parses normal CSV with multiple rows", () => {
    const csv = "timestamp,VTI,BND\n2024-01-02 16:00,251.24,72.05\n2024-01-03 16:00,252.00,71.80";
    const result = csvToJson(csv);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], {
      timestamp: "2024-01-02 16:00",
      VTI: "251.24",
      BND: "72.05",
    });
    assert.deepEqual(result[1], {
      timestamp: "2024-01-03 16:00",
      VTI: "252.00",
      BND: "71.80",
    });
  });

  it("fills missing values with empty strings", () => {
    const csv = "timestamp,VTI,BND\n2024-01-02 16:00,251.24";
    const result = csvToJson(csv);
    assert.equal(result[0].BND, "");
  });

  it("handles Windows line endings", () => {
    const csv = "timestamp,VTI\r\n2024-01-02 16:00,100\r\n";
    const result = csvToJson(csv);
    assert.equal(result.length, 1);
    assert.equal(result[0].VTI, "100");
  });
});

// ---------------------------------------------------------------------------
// prettyJson
// ---------------------------------------------------------------------------

describe("prettyJson", () => {
  it("formats empty array", () => {
    assert.equal(prettyJson([]), "[]");
  });

  it("formats empty object", () => {
    assert.equal(prettyJson({}), "{}");
  });

  it("puts flat objects on a single line in arrays", () => {
    const input = [{ date: "2024-01-02", symbol: "VTI" }];
    const result = prettyJson(input);
    assert.ok(result.includes('{"date":"2024-01-02","symbol":"VTI"}'));
    assert.ok(result.startsWith("[\n"));
    assert.ok(result.endsWith("\n]"));
  });

  it("handles nested objects", () => {
    const input = { accounts: [{ name: "401k" }], values: [] };
    const result = prettyJson(input);
    assert.ok(result.includes('"accounts"'));
    assert.ok(result.includes('"name":"401k"'));
  });

  it("handles primitive values", () => {
    assert.equal(prettyJson("hello"), '"hello"');
    assert.equal(prettyJson(42), "42");
    assert.equal(prettyJson(null), "null");
    assert.equal(prettyJson(true), "true");
  });
});

// ---------------------------------------------------------------------------
// validateTrades
// ---------------------------------------------------------------------------

describe("validateTrades", () => {
  it("returns null for valid array", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100.50", quantity: "10" },
      { date: "2024-01-03", symbol: "BND", price: "72", quantity: "5" },
    ];
    assert.equal(validateTrades(trades), null);
  });

  it("returns null for empty array", () => {
    assert.equal(validateTrades([]), null);
  });

  it("rejects non-array input", () => {
    assert.ok(validateTrades("not an array"));
    assert.ok(validateTrades({}));
    assert.ok(validateTrades(null));
  });

  it("rejects invalid date format", () => {
    const err = validateTrades([{ date: "2024/01/02", symbol: "VTI", price: "100", quantity: "10" }]);
    assert.match(err, /Row 1.*date/);
  });

  it("rejects missing date", () => {
    const err = validateTrades([{ date: "", symbol: "VTI", price: "100", quantity: "10" }]);
    assert.match(err, /Row 1.*date/);
  });

  it("rejects empty symbol", () => {
    const err = validateTrades([{ date: "2024-01-02", symbol: "", price: "100", quantity: "10" }]);
    assert.match(err, /Row 1.*symbol/);
  });

  it("rejects whitespace-only symbol", () => {
    const err = validateTrades([{ date: "2024-01-02", symbol: "  ", price: "100", quantity: "10" }]);
    assert.match(err, /Row 1.*symbol/);
  });

  it("rejects zero price", () => {
    const err = validateTrades([{ date: "2024-01-02", symbol: "VTI", price: "0", quantity: "10" }]);
    assert.match(err, /Row 1.*price/);
  });

  it("rejects non-numeric price", () => {
    const err = validateTrades([{ date: "2024-01-02", symbol: "VTI", price: "abc", quantity: "10" }]);
    assert.match(err, /Row 1.*price/);
  });

  it("rejects zero quantity", () => {
    const err = validateTrades([{ date: "2024-01-02", symbol: "VTI", price: "100", quantity: "0" }]);
    assert.match(err, /Row 1.*quantity/);
  });

  it("accepts negative quantity (sells)", () => {
    assert.equal(
      validateTrades([{ date: "2024-01-02", symbol: "VTI", price: "100", quantity: "-5" }]),
      null
    );
  });

  it("accepts type:drip as a valid trade type", () => {
    assert.equal(
      validateTrades([{ date: "2024-01-02", symbol: "VTI", price: "100", quantity: "0.5", type: "drip" }]),
      null
    );
  });

  it("reports correct row number for errors in later rows", () => {
    const trades = [
      { date: "2024-01-02", symbol: "VTI", price: "100", quantity: "10" },
      { date: "bad-date", symbol: "BND", price: "72", quantity: "5" },
    ];
    const err = validateTrades(trades);
    assert.match(err, /Row 2/);
  });
});

// ---------------------------------------------------------------------------
// normalizeTrades
// ---------------------------------------------------------------------------

describe("normalizeTrades", () => {
  const base = { date: "2024-01-02", symbol: "vti", price: "100.5", quantity: "10" };

  it("uppercases symbol and coerces numeric strings", () => {
    const [h] = normalizeTrades([base]);
    assert.equal(h.symbol, "VTI");
    assert.equal(h.price, "100.5");
    assert.equal(h.quantity, "10");
  });

  it("preserves note field when present", () => {
    const [h] = normalizeTrades([{ ...base, note: "initial position" }]);
    assert.equal(h.note, "initial position");
  });

  it("trims whitespace from note", () => {
    const [h] = normalizeTrades([{ ...base, note: "  recurring buy  " }]);
    assert.equal(h.note, "recurring buy");
  });

  it("omits note key when note is absent", () => {
    const [h] = normalizeTrades([base]);
    assert.ok(!Object.hasOwn(h, "note"), "note key should not be present");
  });

  it("omits note key when note is empty string", () => {
    const [h] = normalizeTrades([{ ...base, note: "" }]);
    assert.ok(!Object.hasOwn(h, "note"), "note key should not be present");
  });

  it("omits note key when note is whitespace only", () => {
    const [h] = normalizeTrades([{ ...base, note: "   " }]);
    assert.ok(!Object.hasOwn(h, "note"), "note key should not be present");
  });

  it("preserves note on rows that have it and omits on rows that don't", () => {
    // normalizeTrades sorts by date descending, so give the note row the later date
    const rows = normalizeTrades([
      { ...base, date: "2024-01-03", note: "second buy" },
      { ...base },
    ]);
    assert.equal(rows[0].note, "second buy");
    assert.ok(!Object.hasOwn(rows[1], "note"));
  });

  it("preserves lotDate alongside note", () => {
    const [h] = normalizeTrades([{ ...base, quantity: "-5", lotDate: "2024-01-02", note: "sell" }]);
    assert.equal(h.lotDate, "2024-01-02");
    assert.equal(h.note, "sell");
  });
});

// ---------------------------------------------------------------------------
// getIP
// ---------------------------------------------------------------------------

function mockReq(remoteAddress, forwardedFor) {
  const headers = forwardedFor ? { "x-forwarded-for": forwardedFor } : {};
  return { headers, socket: { remoteAddress } };
}

describe("getIP", () => {
  it("returns the socket address when no X-Forwarded-For header", () => {
    assert.equal(getIP(mockReq("192.168.1.5")), "192.168.1.5");
  });

  it("strips ::ffff: prefix from IPv4-mapped IPv6 addresses", () => {
    assert.equal(getIP(mockReq("::ffff:10.0.0.1")), "10.0.0.1");
  });

  it("prefers X-Forwarded-For over socket address", () => {
    assert.equal(getIP(mockReq("127.0.0.1", "10.0.0.2")), "10.0.0.2");
  });

  it("takes the first IP from a comma-separated X-Forwarded-For list", () => {
    assert.equal(getIP(mockReq("127.0.0.1", "10.0.0.2, 172.16.0.1")), "10.0.0.2");
  });

  it("trims whitespace from X-Forwarded-For", () => {
    assert.equal(getIP(mockReq("127.0.0.1", "  10.0.0.3  ")), "10.0.0.3");
  });

  it("returns 'unknown' when socket address is missing", () => {
    assert.equal(getIP({ headers: {}, socket: {} }), "unknown");
  });
});

// ---------------------------------------------------------------------------
// serverLog / serverWarn
// ---------------------------------------------------------------------------

describe("serverLog", () => {
  it("writes to stdout with [ISO timestamp] IP - message format", () => {
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      serverLog("1.2.3.4", "page access");
    } finally {
      console.log = orig;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] 1\.2\.3\.4 - page access$/);
  });

  it("includes the tab name in the message", () => {
    const lines = [];
    const orig = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      serverLog("5.6.7.8", "tab: gains");
    } finally {
      console.log = orig;
    }
    assert.match(lines[0], /tab: gains$/);
  });
});

describe("serverWarn", () => {
  it("writes to stderr with WARN prefix and [ISO timestamp] IP - message format", () => {
    const lines = [];
    const orig = console.warn;
    console.warn = (...args) => lines.push(args.join(" "));
    try {
      serverWarn("1.2.3.4", 'bad password: "hunter2"');
    } finally {
      console.warn = orig;
    }
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^WARN \[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] 1\.2\.3\.4 - bad password: "hunter2"$/);
  });
});
