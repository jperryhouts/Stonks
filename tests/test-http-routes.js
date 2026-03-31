/**
 * Integration tests for HTTP routes that are not covered by unit tests:
 *   POST /api/log
 *   POST /api/config
 *   POST /api/assets
 *
 * Each test makes a real HTTP request to a local server instance started
 * with a temporary DATA_DIR.
 */
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

// DATA_DIR must be set BEFORE requiring serve.js (it is read at module load).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "portfolio-test-"));
process.env.DATA_DIR = DATA_DIR;

const { server } = require("../app/serve.js");

let PORT;

/** POST JSON to the test server; resolves with {status, body}. */
function post(urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: urlPath,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => (buf += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(buf) });
          } catch {
            resolve({ status: res.statusCode, body: buf });
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

before(() =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      PORT = server.address().port;
      resolve();
    });
  })
);

after(
  () =>
    new Promise((resolve) => {
      server.close(resolve);
      // Clean up temp dir
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    })
);

// ---------------------------------------------------------------------------
// POST /api/log
// ---------------------------------------------------------------------------

describe("POST /api/log", () => {
  it("returns 200 ok for valid tab name", async () => {
    const r = await post("/api/log", { tab: "Overview" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });

  it("returns 200 ok when tab field is missing (optional)", async () => {
    const r = await post("/api/log", {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true });
  });

  it("returns 200 ok for empty tab string (ignored)", async () => {
    const r = await post("/api/log", { tab: "" });
    assert.equal(r.status, 200);
  });

  it("returns 400 for non-JSON body", async () => {
    // Send malformed JSON by manually constructing the request
    const result = await new Promise((resolve, reject) => {
      const data = "not valid json {{{";
      const req = http.request(
        {
          host: "127.0.0.1",
          port: PORT,
          path: "/api/log",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
        },
        (res) => {
          let buf = "";
          res.on("data", (c) => (buf += c));
          res.on("end", () => resolve({ status: res.statusCode }));
        }
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
    assert.equal(result.status, 400);
  });
});

// ---------------------------------------------------------------------------
// POST /api/config
// ---------------------------------------------------------------------------

describe("POST /api/config", () => {
  const VALID_CONFIG = JSON.stringify({
    chartColors: [{ fill: "#aabbcc", stroke: "#aabbcc" }],
    symbolOrder: ["VTI"],
  });

  it("returns 200 and writes config.json for valid content", async () => {
    const r = await post("/api/config", { content: VALID_CONFIG });
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
    // File should be written
    const written = fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf-8");
    assert.deepEqual(JSON.parse(written), JSON.parse(VALID_CONFIG));
  });

  it("returns 400 when content field is missing", async () => {
    const r = await post("/api/config", { notContent: "{}" });
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  });

  it("returns 400 when content is not a string", async () => {
    const r = await post("/api/config", { content: 42 });
    assert.equal(r.status, 400);
  });

  it("returns 400 when content is invalid JSON", async () => {
    const r = await post("/api/config", { content: "{ broken json" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Invalid JSON/);
  });

  it("returns 400 when config fails validation", async () => {
    const badConfig = JSON.stringify({ chartColors: "not-an-array" });
    const r = await post("/api/config", { content: badConfig });
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  });
});

// ---------------------------------------------------------------------------
// POST /api/assets
// ---------------------------------------------------------------------------

describe("POST /api/assets", () => {
  const VALID_ASSETS = JSON.stringify([
    {
      type: "mortgage",
      name: "Home",
      purchaseDate: "2020-01-15",
      homeValue: "500000",
      downPayment: "100000",
      loanTermYears: 30,
      annualRate: "0.035",
    },
  ]);

  it("returns 200 and writes assets.json for valid content", async () => {
    const r = await post("/api/assets", { content: VALID_ASSETS });
    assert.equal(r.status, 200);
    assert.ok(r.body.ok);
    const written = fs.readFileSync(path.join(DATA_DIR, "assets.json"), "utf-8");
    assert.deepEqual(JSON.parse(written), JSON.parse(VALID_ASSETS));
  });

  it("returns 400 when content field is missing", async () => {
    const r = await post("/api/assets", {});
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  });

  it("returns 400 when content is invalid JSON", async () => {
    const r = await post("/api/assets", { content: "broken {" });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Invalid JSON/);
  });

  it("returns 400 when assets fail validation (unknown type)", async () => {
    const bad = JSON.stringify([{ type: "spaceship", name: "Test" }]);
    const r = await post("/api/assets", { content: bad });
    assert.equal(r.status, 400);
    assert.ok(r.body.error);
  });

  it("returns 400 when assets fail validation (mortgage missing required field)", async () => {
    const bad = JSON.stringify([
      { type: "mortgage", name: "Home", purchaseDate: "2020-01-15" }
      // missing homeValue, downPayment, etc.
    ]);
    const r = await post("/api/assets", { content: bad });
    assert.equal(r.status, 400);
  });
});
