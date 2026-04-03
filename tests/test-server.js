const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { csvToJson, prettyJson, validateTrades, validateRetirement, normalizeTrades, normalizeRetirement, getIP, AUTH_RATE, serverLog, serverWarn, sendCached } = require("../app/serve.js");

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

  it("sorts by date desc, then symbol asc, then type asc, then quantity asc, then price asc", () => {
    // Expected order after sort:
    // [0] 2024-01-02 VTI buy  qty=5 price=101
    // [1] 2024-01-01 VTI buy  qty=3 price=101  ← qty asc
    // [2] 2024-01-01 VTI buy  qty=5 price=101  ← price asc within same qty
    // [3] 2024-01-01 VTI buy  qty=5 price=102
    // [4] 2024-01-01 VTI drip qty=5 price=101  ← type asc (buy before drip)
    // [5] 2024-01-01 VXUS buy qty=5 price=50   ← symbol asc
    const rows = normalizeTrades([
      { date: "2024-01-01", symbol: "VTI",  price: "102", quantity: "5", type: "buy" },
      { date: "2024-01-02", symbol: "VTI",  price: "101", quantity: "5", type: "buy" },
      { date: "2024-01-01", symbol: "VXUS", price: "50",  quantity: "5", type: "buy" },
      { date: "2024-01-01", symbol: "VTI",  price: "101", quantity: "5", type: "buy" },
      { date: "2024-01-01", symbol: "VTI",  price: "101", quantity: "3", type: "buy" },
      { date: "2024-01-01", symbol: "VTI",  price: "101", quantity: "5", type: "drip" },
    ]);
    assert.equal(rows[0].date,     "2024-01-02");  // date desc
    assert.equal(rows[1].quantity, "3");           // quantity asc within same symbol/type
    assert.equal(rows[2].quantity, "5");
    assert.equal(rows[2].price,    "101");         // price asc within same quantity
    assert.equal(rows[3].price,    "102");
    assert.equal(rows[4].type,     "drip");        // type asc (buy before drip)
    assert.equal(rows[5].symbol,   "VXUS");        // symbol asc
  });

  it("breaks ties on price when date/symbol/type/quantity are identical", () => {
    const rows = normalizeTrades([
      { date: "2024-01-01", symbol: "VTI", price: "102", quantity: "10", type: "drip" },
      { date: "2024-01-01", symbol: "VTI", price: "100", quantity: "10", type: "drip" },
      { date: "2024-01-01", symbol: "VTI", price: "101", quantity: "10", type: "drip" },
    ]);
    assert.equal(rows[0].price, "100");
    assert.equal(rows[1].price, "101");
    assert.equal(rows[2].price, "102");
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

  it("takes the last IP from a comma-separated X-Forwarded-For list (proxy-appended, not client-supplied)", () => {
    assert.equal(getIP(mockReq("127.0.0.1", "10.0.0.2, 172.16.0.1")), "172.16.0.1");
  });

  it("trims whitespace from X-Forwarded-For", () => {
    assert.equal(getIP(mockReq("127.0.0.1", "  10.0.0.3  ")), "10.0.0.3");
  });

  it("returns 'unknown' when socket address is missing", () => {
    assert.equal(getIP({ headers: {}, socket: {} }), "unknown");
  });
});

// ---------------------------------------------------------------------------
// AUTH_RATE
// ---------------------------------------------------------------------------

describe("AUTH_RATE", () => {
  // Helper: get a unique IP per test to avoid cross-test state.
  let _n = 0;
  const freshIP = () => `10.99.99.${_n++}`;

  it("returns 0 delay for an IP with no prior failures", () => {
    assert.equal(AUTH_RATE.delay(freshIP()), 0);
  });

  it("returns BASE_MS after the first failure", () => {
    const ip = freshIP();
    AUTH_RATE.record(ip);
    assert.equal(AUTH_RATE.delay(ip), AUTH_RATE.BASE_MS);
    AUTH_RATE.reset(ip);
  });

  it("doubles the delay on each subsequent failure", () => {
    const ip = freshIP();
    AUTH_RATE.record(ip); // 1 → 200 ms
    AUTH_RATE.record(ip); // 2 → 400 ms
    AUTH_RATE.record(ip); // 3 → 800 ms
    assert.equal(AUTH_RATE.delay(ip), AUTH_RATE.BASE_MS * 4);
    AUTH_RATE.reset(ip);
  });

  it("caps delay at MAX_MS regardless of failure count", () => {
    const ip = freshIP();
    for (let i = 0; i < 20; i++) AUTH_RATE.record(ip);
    assert.equal(AUTH_RATE.delay(ip), AUTH_RATE.MAX_MS);
    AUTH_RATE.reset(ip);
  });

  it("reset clears the counter so the next attempt has no delay", () => {
    const ip = freshIP();
    AUTH_RATE.record(ip);
    AUTH_RATE.record(ip);
    AUTH_RATE.reset(ip);
    assert.equal(AUTH_RATE.delay(ip), 0);
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

// ---------------------------------------------------------------------------
// validateRetirement
// ---------------------------------------------------------------------------

describe("validateRetirement", () => {
  const validBody = () => ({
    accounts: [{ name: "401k", proxy: "VTI" }],
    values: [{ date: "2024-01-01", account: "401k", value: "12500" }],
    contributions: [{ date: "2024-01-01", account: "401k", amount: "1000" }],
  });

  it("returns null for a valid body", () => {
    assert.equal(validateRetirement(validBody()), null);
  });

  it("returns null when contributions is absent", () => {
    const body = validBody();
    delete body.contributions;
    assert.equal(validateRetirement(body), null);
  });

  it("returns null for empty accounts, values, and contributions arrays", () => {
    assert.equal(validateRetirement({ accounts: [], values: [], contributions: [] }), null);
  });

  it("rejects null input", () => {
    assert.ok(validateRetirement(null));
  });

  it("rejects array input", () => {
    assert.ok(validateRetirement([]));
  });

  it("rejects non-object input", () => {
    assert.ok(validateRetirement("string"));
  });

  it("rejects missing accounts array", () => {
    const body = validBody();
    delete body.accounts;
    assert.match(validateRetirement(body), /accounts/);
  });

  it("rejects missing values array", () => {
    const body = validBody();
    delete body.values;
    assert.match(validateRetirement(body), /values/);
  });

  // accounts
  it("rejects account with missing name", () => {
    const body = validBody();
    body.accounts[0].name = "";
    assert.match(validateRetirement(body), /Account 1.*name/);
  });

  it("rejects account with whitespace-only name", () => {
    const body = validBody();
    body.accounts[0].name = "   ";
    assert.match(validateRetirement(body), /Account 1.*name/);
  });

  // values
  it("rejects value with missing date", () => {
    const body = validBody();
    body.values[0].date = "";
    assert.match(validateRetirement(body), /Value 1.*date/);
  });

  it("rejects value with wrong date format", () => {
    const body = validBody();
    body.values[0].date = "01/01/2024";
    assert.match(validateRetirement(body), /Value 1.*date/);
  });

  it("rejects value with missing account", () => {
    const body = validBody();
    body.values[0].account = "";
    assert.match(validateRetirement(body), /Value 1.*account/);
  });

  it("rejects value with zero value", () => {
    const body = validBody();
    body.values[0].value = "0";
    assert.match(validateRetirement(body), /Value 1.*value/);
  });

  it("rejects value with non-numeric value", () => {
    const body = validBody();
    body.values[0].value = "abc";
    assert.match(validateRetirement(body), /Value 1.*value/);
  });

  it("rejects value with negative value", () => {
    const body = validBody();
    body.values[0].value = "-100";
    assert.match(validateRetirement(body), /Value 1.*value/);
  });

  it("reports the correct row number for a second invalid value", () => {
    const body = validBody();
    body.values.push({ date: "bad", account: "401k", value: "500" });
    assert.match(validateRetirement(body), /Value 2.*date/);
  });

  // contributions
  it("rejects contribution with missing date", () => {
    const body = validBody();
    body.contributions[0].date = "";
    assert.match(validateRetirement(body), /Contribution 1.*date/);
  });

  it("rejects contribution with wrong date format", () => {
    const body = validBody();
    body.contributions[0].date = "2024/01/01";
    assert.match(validateRetirement(body), /Contribution 1.*date/);
  });

  it("rejects contribution with missing account", () => {
    const body = validBody();
    body.contributions[0].account = "";
    assert.match(validateRetirement(body), /Contribution 1.*account/);
  });

  it("rejects contribution with zero amount", () => {
    const body = validBody();
    body.contributions[0].amount = "0";
    assert.match(validateRetirement(body), /Contribution 1.*amount/);
  });

  it("rejects contribution with non-numeric amount", () => {
    const body = validBody();
    body.contributions[0].amount = "abc";
    assert.match(validateRetirement(body), /Contribution 1.*amount/);
  });

  it("rejects contribution with negative amount", () => {
    const body = validBody();
    body.contributions[0].amount = "-500";
    assert.match(validateRetirement(body), /Contribution 1.*amount/);
  });

  it("reports the correct row number for a second invalid contribution", () => {
    const body = validBody();
    body.contributions.push({ date: "2024-06-01", account: "", amount: "500" });
    assert.match(validateRetirement(body), /Contribution 2.*account/);
  });
});

// ---------------------------------------------------------------------------
// normalizeRetirement
// ---------------------------------------------------------------------------

describe("normalizeRetirement", () => {
  const makeBody = (overrides = {}) => ({
    accounts: [{ name: "401k", proxy: "VTI" }, { name: "Roth IRA", proxy: "VTI" }],
    values: [],
    contributions: [],
    ...overrides,
  });

  it("sorts accounts alphabetically by name", () => {
    const { accounts } = normalizeRetirement(makeBody());
    assert.equal(accounts[0].name, "401k");
    assert.equal(accounts[1].name, "Roth IRA");
  });

  it("sorts accounts alphabetically regardless of input order", () => {
    const body = makeBody();
    body.accounts = [{ name: "Roth IRA", proxy: "VTI" }, { name: "401k", proxy: "VTI" }];
    const { accounts } = normalizeRetirement(body);
    assert.equal(accounts[0].name, "401k");
    assert.equal(accounts[1].name, "Roth IRA");
  });

  it("sorts values by date desc, then account asc", () => {
    const body = makeBody({
      values: [
        { date: "2024-01-01", account: "Roth IRA", value: "20000" },
        { date: "2024-02-01", account: "401k",     value: "50000" },
        { date: "2024-01-01", account: "401k",     value: "45000" },
      ],
    });
    const { values } = normalizeRetirement(body);
    assert.equal(values[0].date, "2024-02-01");
    assert.equal(values[1].account, "401k");
    assert.equal(values[2].account, "Roth IRA");
  });

  it("sorts values by account asc regardless of input order (same day, two accounts)", () => {
    const body = makeBody({
      values: [
        { date: "2024-01-01", account: "Roth IRA", value: "20000" },
        { date: "2024-01-01", account: "401k",     value: "45000" },
      ],
    });
    const { values } = normalizeRetirement(body);
    assert.equal(values[0].account, "401k");
    assert.equal(values[1].account, "Roth IRA");
  });

  it("breaks value ties on numeric value asc when date and account are identical", () => {
    const body = makeBody({
      values: [
        { date: "2024-01-01", account: "401k", value: "50000" },
        { date: "2024-01-01", account: "401k", value: "45000" },
      ],
    });
    const { values } = normalizeRetirement(body);
    assert.equal(values[0].value, "45000");
    assert.equal(values[1].value, "50000");
  });

  it("sorts contributions by date desc, then account asc", () => {
    const body = makeBody({
      contributions: [
        { date: "2024-01-01", account: "Roth IRA", amount: "500" },
        { date: "2024-02-01", account: "401k",     amount: "1000" },
        { date: "2024-01-01", account: "401k",     amount: "800" },
      ],
    });
    const { contributions } = normalizeRetirement(body);
    assert.equal(contributions[0].date, "2024-02-01");
    assert.equal(contributions[1].account, "401k");
    assert.equal(contributions[2].account, "Roth IRA");
  });

  it("sorts contributions by account asc regardless of input order (same day, two accounts)", () => {
    const body = makeBody({
      contributions: [
        { date: "2024-01-01", account: "Roth IRA", amount: "500" },
        { date: "2024-01-01", account: "401k",     amount: "800" },
      ],
    });
    const { contributions } = normalizeRetirement(body);
    assert.equal(contributions[0].account, "401k");
    assert.equal(contributions[1].account, "Roth IRA");
  });

  it("breaks contribution ties on numeric amount asc when date and account are identical", () => {
    const body = makeBody({
      contributions: [
        { date: "2024-01-01", account: "401k", amount: "1000" },
        { date: "2024-01-01", account: "401k", amount: "500" },
      ],
    });
    const { contributions } = normalizeRetirement(body);
    assert.equal(contributions[0].amount, "500");
    assert.equal(contributions[1].amount, "1000");
  });

  it("defaults missing contributions to empty array", () => {
    const body = { accounts: [], values: [] };
    const { contributions } = normalizeRetirement(body);
    assert.deepEqual(contributions, []);
  });
});

// ---------------------------------------------------------------------------
// sendCached
// ---------------------------------------------------------------------------

describe("sendCached", () => {
  function makeRes() {
    const headers = {};
    let statusCode = null;
    let body = null;
    return {
      writeHead(code, hdrs) { statusCode = code; Object.assign(headers, hdrs); },
      end(data) { body = data; },
      _statusCode() { return statusCode; },
      _headers() { return headers; },
      _body() { return body; },
    };
  }

  it("serves raw data when Accept-Encoding does not include gzip", () => {
    const res = makeRes();
    const req = { headers: { "accept-encoding": "identity" } };
    const data = Buffer.from("hello");
    const gz = Buffer.from("fake-gz");
    sendCached(res, "application/json", { data, gz }, req, {});
    assert.equal(res._statusCode(), 200);
    assert.equal(res._headers()["content-encoding"], undefined);
    assert.deepEqual(res._body(), data);
  });

  it("serves gzip when Accept-Encoding includes gzip and gz is non-null", () => {
    const res = makeRes();
    const req = { headers: { "accept-encoding": "gzip, deflate" } };
    const data = Buffer.from("hello");
    const gz = Buffer.from("fake-gz");
    sendCached(res, "application/json", { data, gz }, req, {});
    assert.equal(res._statusCode(), 200);
    assert.equal(res._headers()["content-encoding"], "gzip");
    assert.equal(res._headers()["vary"], "Accept-Encoding");
    assert.deepEqual(res._body(), gz);
  });

  it("falls back to raw data when gz is null even if gzip accepted", () => {
    const res = makeRes();
    const req = { headers: { "accept-encoding": "gzip" } };
    const data = Buffer.from("hi");
    sendCached(res, "text/plain", { data, gz: null }, req, {});
    assert.equal(res._headers()["content-encoding"], undefined);
    assert.deepEqual(res._body(), data);
  });

  it("serves raw data when accept-encoding header is absent", () => {
    const res = makeRes();
    const req = { headers: {} };
    const data = Buffer.from("hello");
    const gz = Buffer.from("fake-gz");
    sendCached(res, "application/json", { data, gz }, req, {});
    assert.equal(res._headers()["content-encoding"], undefined);
    assert.deepEqual(res._body(), data);
  });

  it("merges extra headers into response", () => {
    const res = makeRes();
    const req = { headers: {} };
    const data = Buffer.from("x");
    sendCached(res, "text/html", { data, gz: null }, req, { "cache-control": "no-store" });
    assert.equal(res._headers()["cache-control"], "no-store");
  });

  it("includes etag header derived from entry.mtime on 200", () => {
    const res = makeRes();
    const req = { headers: {} };
    sendCached(res, "text/plain", { mtime: 12345, data: Buffer.from("x"), gz: null }, req);
    assert.equal(res._statusCode(), 200);
    assert.equal(res._headers()["etag"], '"12345"');
  });

  it("uses entry.etag over entry.mtime when both are present", () => {
    const res = makeRes();
    const req = { headers: {} };
    sendCached(res, "text/plain", { mtime: 12345, etag: '"abc,def"', data: Buffer.from("x"), gz: null }, req);
    assert.equal(res._headers()["etag"], '"abc,def"');
  });

  it("returns 304 with etag when If-None-Match matches entry.mtime etag", () => {
    const res = makeRes();
    const req = { headers: { "if-none-match": '"12345"' } };
    sendCached(res, "text/plain", { mtime: 12345, data: Buffer.from("x"), gz: null }, req);
    assert.equal(res._statusCode(), 304);
    assert.equal(res._headers()["etag"], '"12345"');
  });

  it("returns 304 with etag when If-None-Match matches entry.etag", () => {
    const res = makeRes();
    const req = { headers: { "if-none-match": '"abc,def"' } };
    sendCached(res, "text/plain", { mtime: 12345, etag: '"abc,def"', data: Buffer.from("x"), gz: null }, req);
    assert.equal(res._statusCode(), 304);
    assert.equal(res._headers()["etag"], '"abc,def"');
  });

  it("304 response has empty body", () => {
    const res = makeRes();
    const req = { headers: { "if-none-match": '"99"' } };
    sendCached(res, "text/plain", { mtime: 99, data: Buffer.from("hello"), gz: null }, req);
    assert.equal(res._statusCode(), 304);
    assert.equal(res._body(), undefined);
  });

  it("returns 200 when If-None-Match does not match", () => {
    const res = makeRes();
    const req = { headers: { "if-none-match": '"stale"' } };
    sendCached(res, "text/plain", { mtime: 99, data: Buffer.from("hello"), gz: null }, req);
    assert.equal(res._statusCode(), 200);
  });
});
