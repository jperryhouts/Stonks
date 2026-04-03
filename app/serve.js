#!/usr/bin/env node
// Minimal static file server — zero dependencies.
// Serves app/ assets directly, plus data/ JSON files.
// Usage: node app/serve.js [port]

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = parseInt(process.argv[2] || "8000", 10);
const APP_DIR = __dirname;                           // app/

const DATA_DIR = process.env.DATA_DIR || "";

const AUTH_PASS = process.env.AUTH_PASS || "";
const AUTH_ENABLED = AUTH_PASS.length > 0;
const AUTH_LOG_PASSWORDS = process.env.AUTH_LOG_PASSWORDS === "1";
const AUTH_KEY = crypto.randomBytes(32); // ephemeral key for HMAC-based comparison

// Scrypt hash support: AUTH_PASS may be "scrypt:<base64-salt>:<base64-hash>".
const SCRYPT_PREFIX = "scrypt:";
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const SCRYPT_KEYLEN = 32;
let AUTH_PASS_SALT = null;
let AUTH_PASS_HASH = null;

if (AUTH_PASS.startsWith(SCRYPT_PREFIX)) {
    const parts = AUTH_PASS.slice(SCRYPT_PREFIX.length).split(":");
    if (parts.length === 2) {
        AUTH_PASS_SALT = Buffer.from(parts[0], "base64");
        AUTH_PASS_HASH = Buffer.from(parts[1], "base64");
    }
    if (!AUTH_PASS_SALT || AUTH_PASS_SALT.length !== 16 ||
        !AUTH_PASS_HASH || AUTH_PASS_HASH.length !== SCRYPT_KEYLEN) {
        console.error("ERROR: Malformed scrypt hash in AUTH_PASS. Generate one with: make hash-password PASSWORD=...");
        process.exit(1);
    }
}

/** Per-IP authentication rate limiter using exponential backoff.
 *  After each failed attempt the IP must wait BASE_MS × 2^(failures−1),
 *  capped at MAX_MS.  Counters expire automatically after EXPIRY_MS of
 *  inactivity so legitimate users are never permanently locked out.
 */
const AUTH_RATE = {
    BASE_MS:   200,
    MAX_MS:    30_000,
    EXPIRY_MS: 60 * 60 * 1000, // 1 hour
    _map:      new Map(),       // ip → { n: failureCount, ts: lastFailureTime }

    /** Milliseconds to wait before processing an auth attempt from this IP. */
    delay(ip) {
        const e = this._map.get(ip);
        if (!e) return 0;
        if (Date.now() - e.ts > this.EXPIRY_MS) { this._map.delete(ip); return 0; }
        return Math.min(this.BASE_MS * Math.pow(2, e.n - 1), this.MAX_MS);
    },

    /** Record a failed attempt. */
    record(ip) {
        const e = this._map.get(ip) || { n: 0, ts: 0 };
        e.n++;
        e.ts = Date.now();
        this._map.set(ip, e);
    },

    /** Clear the counter after a successful login. */
    reset(ip) { this._map.delete(ip); },
};

const MIME = {
    ".html": "text/html",
    ".css":  "text/css",
    ".js":   "text/javascript",
    ".json": "application/json",
    ".svg":  "image/svg+xml",
    ".png":  "image/png",
};

const SEC_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'sha256-6ZeVojpIEHRFC4Rwwl4418UmEumrFjgLT6LOPg/q6n8='; img-src 'self'; media-src 'none'; connect-src 'self'",
};

// Files in app/ that are server tooling, not browser content.
const APP_SKIP = new Set(["build.js", "serve.js"]);

// Allowlisted filenames for /data/ and /config/ routes.
const DATA_ALLOW = new Set(["market.json", "trades.json", "retirement.json", "assets.json", "config.json"]);

// 1×1 transparent GIF — served inline for /favicon.ico to avoid filesystem lookup.
const FAVICON = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/** Split a single CSV line respecting RFC 4180 double-quote escaping. */
function parseCsvLine(line) {
    const fields = [];
    let i = 0;
    while (i <= line.length) {
        if (i === line.length) { fields.push(""); break; }
        if (line[i] === '"') {
            let field = "";
            i++; // skip opening quote
            while (i < line.length) {
                if (line[i] === '"') {
                    if (i + 1 < line.length && line[i + 1] === '"') {
                        field += '"'; i += 2; // escaped quote
                    } else {
                        i++; break; // closing quote
                    }
                } else {
                    field += line[i++];
                }
            }
            if (i < line.length && line[i] === ",") i++;
            fields.push(field);
        } else {
            const end = line.indexOf(",", i);
            if (end === -1) { fields.push(line.slice(i)); break; }
            fields.push(line.slice(i, end));
            i = end + 1;
        }
    }
    return fields;
}

/** Parse a CSV string into an array of objects keyed by header names. */
function csvToJson(text) {
    const lines = text.replace(/\r/g, "").trimEnd().split("\n");
    if (lines.length === 0) return [];
    const headers = parseCsvLine(lines[0]);
    return lines.slice(1).map(line => {
        const values = parseCsvLine(line);
        const row = {};
        headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
        return row;
    });
}

/**
 * Pretty-print JSON keeping flat objects (all primitive values) on a single line.
 * Arrays of flat objects get one object per line; nested structures recurse normally.
 */
function prettyJson(val, indent) {
    indent = indent || "";
    var inner = indent + "  ";
    if (Array.isArray(val)) {
        if (val.length === 0) return "[]";
        var allSimple = val.every(function (item) {
            return item && typeof item === "object" && !Array.isArray(item) &&
                Object.values(item).every(function (v) { return v === null || typeof v !== "object"; });
        });
        if (allSimple) {
            return "[\n" + val.map(function (item) { return inner + JSON.stringify(item); }).join(",\n") + "\n" + indent + "]";
        }
        return "[\n" + val.map(function (item) { return inner + prettyJson(item, inner); }).join(",\n") + "\n" + indent + "]";
    }
    if (val && typeof val === "object") {
        var keys = Object.keys(val);
        if (keys.length === 0) return "{}";
        return "{\n" + keys.map(function (k) { return inner + JSON.stringify(k) + ": " + prettyJson(val[k], inner); }).join(",\n") + "\n" + indent + "}";
    }
    return JSON.stringify(val);
}

// In-memory cache: filePath → { mtime: number, data: Buffer|string, gz: Buffer|null }
const fileCache = new Map();

// Ordered list of JS files that form the client bundle (must match <script> execution order).
const JS_FILES = [
    "js/config.js", "js/fmt.js", "js/data.js", "js/retirement.js",
    "js/assets.js", "js/gains.js", "js/returns.js", "js/validate.js",
    "js/ui-utils.js", "js/allocation.js", "js/settings.js", "js/app.js",
];

// Bundle cache: rebuilt whenever any constituent file's mtime changes.
let bundleCache = null; // { key: string, mtime: number, etag: string, data: Buffer, gz: Buffer|null }

function getBundle() {
    const paths = JS_FILES.map(f => path.join(APP_DIR, f));
    const mtimes = paths.map(p => fs.statSync(p).mtimeMs);
    const key = mtimes.join(",");
    if (bundleCache && bundleCache.key === key) return bundleCache;
    const nl = Buffer.from("\n");
    const buffers = [];
    for (const p of paths) {
        if (buffers.length > 0) buffers.push(nl);
        buffers.push(fs.readFileSync(p));
    }
    const data = Buffer.concat(buffers);
    const gz = data.length >= 1024 ? zlib.gzipSync(data) : null;
    bundleCache = { key, mtime: Math.max(...mtimes), etag: '"' + key + '"', data, gz };
    return bundleCache;
}


/**
 * Return a cache entry { mtime, data, gz } for filePath.
 * Reads from disk and (re-)compresses only when mtime has changed.
 * Throws on ENOENT or other errors.
 */
function getCachedFile(filePath) {
    const stat = fs.statSync(filePath);
    const mtime = stat.mtimeMs;
    const cached = fileCache.get(filePath);
    if (cached && cached.mtime === mtime) return cached;
    const data = fs.readFileSync(filePath);
    const gz = data.length >= 1024 ? zlib.gzipSync(data) : null;
    const entry = { mtime, data, gz };
    fileCache.set(filePath, entry);
    return entry;
}

/**
 * Optimistic locking check for write endpoints.
 * If the request has an If-Match header, compare it to the file's current
 * mtime-based ETag. Returns true if the write should proceed, false if it
 * should be rejected with 412 Precondition Failed.
 * When the file does not exist yet there is nothing to conflict with, so
 * true is returned regardless of the header value.
 */
function checkIfMatch(req, filePath) {
    const ifMatch = req.headers["if-match"];
    if (!ifMatch) return true;
    let mtime;
    try {
        mtime = fs.statSync(filePath).mtimeMs;
    } catch (e) {
        if (e.code === "ENOENT") return true;
        throw e;
    }
    return ifMatch === ('"' + mtime + '"');
}

/**
 * Write a successful cached response, serving gzip when the client accepts it
 * and a compressed buffer exists. extraHeaders is merged into the response.
 * Sends 304 Not Modified when the client's If-None-Match matches the entry mtime.
 */
function sendCached(res, contentType, entry, req, extraHeaders) {
    extraHeaders = extraHeaders || {};
    const etag = entry.etag || ('"' + entry.mtime + '"');
    if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { ...SEC_HEADERS, ...extraHeaders, "etag": etag });
        res.end();
        return;
    }
    const acceptsGzip = (req.headers["accept-encoding"] || "").includes("gzip");
    if (acceptsGzip && entry.gz) {
        res.writeHead(200, {
            ...SEC_HEADERS, ...extraHeaders,
            "content-type": contentType,
            "content-encoding": "gzip",
            "vary": "Accept-Encoding",
            "etag": etag,
        });
        res.end(entry.gz);
    } else {
        const varyHeaders = entry.gz ? { "vary": "Accept-Encoding" } : {};
        res.writeHead(200, { ...SEC_HEADERS, ...extraHeaders, ...varyHeaders, "content-type": contentType, "etag": etag });
        res.end(entry.data);
    }
}

const MAX_BODY = 1 * 1024 * 1024; // 1 MB

/** Read JSON request body, rejecting payloads larger than MAX_BODY. */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", c => {
            total += c.length;
            if (total > MAX_BODY) {
                req.destroy();
                reject(Object.assign(new Error("Request body too large"), { statusCode: 413 }));
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
            catch (e) { reject(e); }
        });
        req.on("error", reject);
    });
}

/** Extract the client's IP address, preferring X-Forwarded-For when present.
 *  Takes the LAST entry in X-Forwarded-For — that is the IP appended by the
 *  nearest trusted reverse proxy and cannot be forged by the client.
 *  (The first entry is client-supplied and trivially spoofable.)
 */
function getIP(req) {
    const fwd = req.headers["x-forwarded-for"];
    const raw = fwd ? fwd.split(",").at(-1).trim() : (req.socket.remoteAddress || "unknown");
    return raw.replace(/^::ffff:/, ""); // strip IPv4-mapped IPv6 prefix
}

/** Log a timestamped message to stdout. */
function serverLog(ip, msg) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${ip} - ${msg}`);
}

/** Write content to filePath atomically via a .tmp file + rename. */
function writeFileAtomic(filePath, content) {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, filePath);
}

/** Log a timestamped warning to stderr. */
function serverWarn(ip, msg) {
    const ts = new Date().toISOString();
    console.warn(`WARN [${ts}] ${ip} - ${msg}`);
}

/** Constant-time string comparison via HMAC. Safe regardless of input length. */
function safeEqual(a, b) {
    const ha = crypto.createHmac("sha256", AUTH_KEY).update(a).digest();
    const hb = crypto.createHmac("sha256", AUTH_KEY).update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** Verify a password against the stored AUTH_PASS (hashed or plaintext). */
async function verifyPassword(candidate) {
    if (AUTH_PASS_HASH) {
        const derived = await new Promise((resolve, reject) =>
            crypto.scrypt(candidate, AUTH_PASS_SALT, SCRYPT_KEYLEN, SCRYPT_OPTS, (err, key) =>
                err ? reject(err) : resolve(key)));
        return crypto.timingSafeEqual(derived, AUTH_PASS_HASH);
    }
    return safeEqual(candidate, AUTH_PASS);
}

/** Check Basic Auth credentials. Returns true if valid or auth is disabled. */
async function checkAuth(req, res, ip) {
    if (!AUTH_ENABLED) return true;

    // Apply backoff delay for IPs with prior failures (non-blocking async wait).
    const delay = AUTH_RATE.delay(ip);
    if (delay > 0) await new Promise(r => setTimeout(r, delay));

    const header = req.headers.authorization || "";
    if (!header.startsWith("Basic ")) {
        AUTH_RATE.record(ip);
        res.writeHead(401, { ...SEC_HEADERS, "WWW-Authenticate": 'Basic realm="Portfolio"' });
        res.end("Unauthorized");
        return false;
    }
    const decoded = Buffer.from(header.slice(6), "base64").toString();
    const colon = decoded.indexOf(":");
    if (colon < 0) {
        AUTH_RATE.record(ip);
        serverWarn(ip, "bad auth header (no colon in credentials)");
        res.writeHead(401, { ...SEC_HEADERS, "WWW-Authenticate": 'Basic realm="Portfolio"' });
        res.end("Unauthorized");
        return false;
    }
    const pass = decoded.slice(colon + 1);
    if (!await verifyPassword(pass)) {
        AUTH_RATE.record(ip);
        serverWarn(ip, AUTH_LOG_PASSWORDS ? `bad password: "${pass}"` : "authentication failed");
        res.writeHead(401, { ...SEC_HEADERS, "WWW-Authenticate": 'Basic realm="Portfolio"' });
        res.end("Unauthorized");
        return false;
    }
    AUTH_RATE.reset(ip);
    return true;
}

/** Normalize a validated trades array for storage. */
function normalizeTrades(arr) {
    const rows = arr.map(h => {
        const hasType = h.type && h.type.trim();
        return {
            date: h.date,
            symbol: h.symbol.trim().toUpperCase(),
            price: String(Number(h.price)),
            // When type is present, quantity is always stored as positive (direction is in type).
            // Legacy records without type preserve their signed quantity.
            quantity: hasType ? String(Math.abs(Number(h.quantity))) : String(Number(h.quantity)),
            ...(h.lotDate && h.lotDate.trim() ? { lotDate: h.lotDate.trim() } : {}),
            ...(h.note && h.note.trim() ? { note: h.note.trim() } : {}),
            ...(hasType ? { type: h.type.trim() } : {}),
        };
    });
    rows.sort((a, b) => {
        if (a.date !== b.date) return a.date > b.date ? -1 : 1;
        if (a.symbol !== b.symbol) return a.symbol < b.symbol ? -1 : 1;
        if ((a.type || "") !== (b.type || "")) return (a.type || "") < (b.type || "") ? -1 : 1;
        if (a.quantity !== b.quantity) return Number(a.quantity) - Number(b.quantity);
        return Number(a.price) - Number(b.price);
    });
    return rows;
}

/** Validate trades array. Returns error string or null. */
function validateTrades(arr) {
    if (!Array.isArray(arr)) return "Expected an array";
    for (let i = 0; i < arr.length; i++) {
        const h = arr[i];
        if (!h.date || !/^\d{4}-\d{2}-\d{2}$/.test(h.date))
            return `Row ${i + 1}: invalid date (expected YYYY-MM-DD)`;
        {
            const [yy, mm, dd] = h.date.split("-").map(Number);
            const parsed = new Date(Date.UTC(yy, mm - 1, dd));
            if (parsed.getUTCFullYear() !== yy || parsed.getUTCMonth() + 1 !== mm || parsed.getUTCDate() !== dd)
                return `Row ${i + 1}: invalid date (expected YYYY-MM-DD)`;
        }
        if (!h.symbol || typeof h.symbol !== "string" || h.symbol.trim() === "")
            return `Row ${i + 1}: symbol is required`;
        if (h.price === "" || !isFinite(Number(h.price)) || Number(h.price) <= 0)
            return `Row ${i + 1}: invalid price`;
        if (h.quantity === "" || !isFinite(Number(h.quantity)) || Number(h.quantity) === 0)
            return `Row ${i + 1}: invalid quantity`;
        if (h.lotDate !== undefined && h.lotDate !== "" &&
            !/^\d{4}-\d{2}-\d{2}$/.test(h.lotDate))
            return `Row ${i + 1}: invalid lotDate (expected YYYY-MM-DD)`;
        if (h.type !== undefined && h.type !== "" &&
            h.type !== "buy" && h.type !== "sell" && h.type !== "donate" && h.type !== "drip")
            return `Row ${i + 1}: invalid type (must be "buy", "sell", "donate", or "drip")`;
    }
    return null;
}

/** Normalize and sort retirement body. Returns { accounts, values, contributions }. */
function normalizeRetirement(body) {
    const cleanAccounts = body.accounts.map(a => ({
        name: a.name.trim(),
        proxy: (a.proxy || "VTI").trim().toUpperCase(),
    }));
    cleanAccounts.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const cleanValues = body.values.map(v => ({
        date: v.date,
        account: v.account.trim(),
        value: String(Number(v.value)),
    }));
    cleanValues.sort((a, b) => {
        if (a.date !== b.date) return a.date > b.date ? -1 : 1;
        if (a.account !== b.account) return a.account < b.account ? -1 : 1;
        return Number(a.value) - Number(b.value);
    });
    const contributions = Array.isArray(body.contributions) ? body.contributions : [];
    const cleanContributions = contributions.map(c => ({
        date: c.date,
        account: c.account.trim(),
        amount: String(Number(String(c.amount).replace(/[$,]/g, "").trim())),
    }));
    cleanContributions.sort((a, b) => {
        if (a.date !== b.date) return a.date > b.date ? -1 : 1;
        if (a.account !== b.account) return a.account < b.account ? -1 : 1;
        return Number(a.amount) - Number(b.amount);
    });
    return { accounts: cleanAccounts, values: cleanValues, contributions: cleanContributions };
}

/** Validate config object. Returns error string or null. */
function isValidColorString(s) {
    if (/^#[0-9a-fA-F]{3}$/.test(s)) return true;
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return true;
    if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(s)) return true;
    if (/^rgba\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*[\d.]+\s*\)$/.test(s)) return true;
    return false;
}

function validateConfig(obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj))
        return "Expected a non-null object";
    // chartColors is the canonical name; colors is accepted for backwards compatibility
    for (const colorKey of ["chartColors", "colors"]) {
        if (obj[colorKey] !== undefined) {
            if (!Array.isArray(obj[colorKey])) return `${colorKey} must be an array`;
            for (let i = 0; i < obj[colorKey].length; i++) {
                const c = obj[colorKey][i];
                if (typeof c === "string") {
                    if (!isValidColorString(c)) return `${colorKey}[${i}]: invalid color string "${c}"`;
                    continue;
                }
                if (!c || typeof c.fill !== "string") return `${colorKey}[${i}]: fill must be a string`;
                if (typeof c.stroke !== "string") return `${colorKey}[${i}]: stroke must be a string`;
            }
        }
    }
    if (obj.symbolOrder !== undefined) {
        if (!Array.isArray(obj.symbolOrder)) return "symbolOrder must be an array";
        for (let i = 0; i < obj.symbolOrder.length; i++) {
            if (typeof obj.symbolOrder[i] !== "string")
                return `symbolOrder[${i}]: must be a string`;
        }
    }
    if (obj.exposure !== undefined) {
        if (obj.exposure.allocations !== undefined) {
            const allocs = obj.exposure.allocations;
            if (Array.isArray(allocs)) {
                // Array format: [{ symbol, category, fraction }]
                const sums = {};
                for (let i = 0; i < allocs.length; i++) {
                    const entry = allocs[i];
                    const sym = entry.symbol;
                    const frac = Number(entry.fraction);
                    if (!isNaN(frac)) {
                        sums[sym] = (sums[sym] || 0) + frac;
                    }
                }
                for (const sym of Object.keys(sums)) {
                    if (Math.abs(sums[sym] - 1.0) > 0.01)
                        return `exposure.allocations: fractions for "${sym}" sum to ${sums[sym].toFixed(4)}, expected 1.0`;
                }
            } else if (allocs && typeof allocs === "object") {
                // Object format: { "VTI": { "US Stocks": 0.6, "Bonds": 0.4 } }
                for (const sym of Object.keys(allocs)) {
                    const categories = allocs[sym];
                    if (categories && typeof categories === "object" && !Array.isArray(categories)) {
                        const vals = Object.values(categories).map(Number).filter(v => !isNaN(v));
                        const sum = vals.reduce((a, b) => a + b, 0);
                        if (vals.length > 0 && Math.abs(sum - 1.0) > 0.01)
                            return `exposure.allocations: fractions for "${sym}" sum to ${sum.toFixed(4)}, expected 1.0`;
                    }
                }
            }
        }
        if (obj.exposure.display !== undefined) {
            if (!Array.isArray(obj.exposure.display)) return "exposure.display must be an array";
            for (let i = 0; i < obj.exposure.display.length; i++) {
                const d = obj.exposure.display[i];
                if (!d || typeof d.name !== "string") return `exposure.display[${i}]: name must be a string`;
                if (typeof d.color !== "string") return `exposure.display[${i}]: color must be a string`;
            }
        }
        if (obj.exposure.tradeable !== undefined) {
            if (!Array.isArray(obj.exposure.tradeable)) return "exposure.tradeable must be an array";
            for (let i = 0; i < obj.exposure.tradeable.length; i++) {
                if (typeof obj.exposure.tradeable[i] !== "string")
                    return `exposure.tradeable[${i}]: must be a string`;
            }
        }
    }
    return null;
}

/** Validate assets array. Returns error string or null. */
function validateAssets(arr) {
    if (!Array.isArray(arr)) return "Expected an array";
    const VALID_TYPES = new Set(["mortgage", "ibond", "margin_loan"]);
    for (let i = 0; i < arr.length; i++) {
        const entry = arr[i];
        if (!entry.type || !VALID_TYPES.has(entry.type))
            return `Entry ${i}: unknown type "${entry.type}"`;
        if (!entry.name) return `Entry ${i}: name is required`;
        if (entry.type === "mortgage") {
            for (const field of ["purchaseDate", "homeValue", "downPayment", "loanTermYears", "annualRate"]) {
                if (entry[field] === undefined || entry[field] === null || entry[field] === "")
                    return `Entry ${i}: ${field} is required`;
            }
        } else if (entry.type === "ibond") {
            for (const field of ["purchaseDate", "purchaseValue", "fixedRate"]) {
                if (entry[field] === undefined || entry[field] === null || entry[field] === "")
                    return `Entry ${i}: ${field} is required`;
            }
            if (!Array.isArray(entry.rates)) return `Entry ${i}: rates must be an array`;
        } else if (entry.type === "margin_loan") {
            if (!Array.isArray(entry.balances)) return `Entry ${i}: balances must be an array`;
        }
    }
    return null;
}

/** Validate retirement body. Returns error string or null. */
function validateRetirement(body) {
    if (!body || typeof body !== "object" || Array.isArray(body))
        return "Expected an object with accounts and values";
    if (!Array.isArray(body.accounts)) return "accounts must be an array";
    if (!Array.isArray(body.values)) return "values must be an array";
    for (let i = 0; i < body.accounts.length; i++) {
        const a = body.accounts[i];
        if (!a.name || typeof a.name !== "string" || a.name.trim() === "")
            return `Account ${i + 1}: name is required`;
    }
    for (let i = 0; i < body.values.length; i++) {
        const v = body.values[i];
        if (!v.date || !/^\d{4}-\d{2}-\d{2}$/.test(v.date))
            return `Value ${i + 1}: invalid date (expected YYYY-MM-DD)`;
        if (!v.account || typeof v.account !== "string" || v.account.trim() === "")
            return `Value ${i + 1}: account is required`;
        if (v.value === "" || !isFinite(Number(v.value)) || Number(v.value) <= 0)
            return `Value ${i + 1}: invalid value (must be positive number)`;
    }
    const contributions = Array.isArray(body.contributions) ? body.contributions : [];
    for (let i = 0; i < contributions.length; i++) {
        const c = contributions[i];
        if (!c.date || !/^\d{4}-\d{2}-\d{2}$/.test(c.date))
            return `Contribution ${i + 1}: invalid date (expected YYYY-MM-DD)`;
        if (!c.account || typeof c.account !== "string" || c.account.trim() === "")
            return `Contribution ${i + 1}: account is required`;
        const cAmountNum = Number(String(c.amount).replace(/[$,]/g, "").trim());
        if (!isFinite(cAmountNum) || cAmountNum <= 0)
            return `Contribution ${i + 1}: invalid amount (must be positive number)`;
    }
    return null;
}

const server = http.createServer(async (req, res) => {
    const ip = getIP(req);
    if (!await checkAuth(req, res, ip)) return;

    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);

    // --- API: tab switch log ---
    if (pathname === "/api/log" && req.method === "POST") {
        try {
            const body = await readBody(req);
            if (body && typeof body.tab === "string" && body.tab.trim()) {
                serverLog(ip, `tab: ${body.tab.trim()}`);
            }
            res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            res.writeHead(400, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "bad request" }));
        }
        return;
    }

    // --- API: save trades ---
    if (pathname === "/api/trades" && req.method === "POST") {
        try {
            const body = await readBody(req);
            const err = validateTrades(body);
            if (err) {
                res.writeHead(400, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err }));
                return;
            }
            // Normalize values
            const clean = normalizeTrades(body);
            // Write JSON directly — no rebuild needed
            const tradesPath = path.join(DATA_DIR, "trades.json");
            const tradesContent = prettyJson(clean);
            writeFileAtomic(tradesPath, tradesContent);
            try {
                const written = Buffer.from(tradesContent);
                const gz = written.length >= 1024 ? zlib.gzipSync(written) : null;
                fileCache.set(tradesPath, { mtime: fs.statSync(tradesPath).mtimeMs, data: written, gz });
            } catch (_) {}
            res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, rows: clean.length }));
        } catch (e) {
            const status = e.statusCode || 500;
            console.error("POST /api/trades error:", e);
            res.writeHead(status, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: status === 413 ? "Request body too large" : "Internal server error" }));
        }
        return;
    }

    // --- API: save retirement account values ---
    if (pathname === "/api/retirement" && req.method === "POST") {
        try {
            const retirementPath = path.join(DATA_DIR, "retirement.json");
            if (!checkIfMatch(req, retirementPath)) {
                res.writeHead(412, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Precondition Failed: file was modified since last loaded" }));
                return;
            }
            const body = await readBody(req);
            const retirementErr = validateRetirement(body);
            if (retirementErr) {
                res.writeHead(400, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: retirementErr }));
                return;
            }
            const clean = normalizeRetirement(body);
            const retirementContent = prettyJson(clean);
            writeFileAtomic(retirementPath, retirementContent);
            let newEtag = null;
            try {
                const written = Buffer.from(retirementContent);
                const gz = written.length >= 1024 ? zlib.gzipSync(written) : null;
                const newMtime = fs.statSync(retirementPath).mtimeMs;
                fileCache.set(retirementPath, { mtime: newMtime, data: written, gz });
                newEtag = '"' + newMtime + '"';
            } catch (_) {}
            serverLog(ip, "retirement saved");
            res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, values: clean.values.length, etag: newEtag }));
        } catch (e) {
            const status = e.statusCode || 500;
            console.error("POST /api/retirement error:", e);
            res.writeHead(status, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: status === 413 ? "Request body too large" : "Internal server error" }));
        }
        return;
    }

    // --- API: save config ---
    if (pathname === "/api/config" && req.method === "POST") {
        try {
            const configPath = path.join(DATA_DIR, "config.json");
            if (!checkIfMatch(req, configPath)) {
                res.writeHead(412, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Precondition Failed: file was modified since last loaded" }));
                return;
            }
            const body = await readBody(req);
            if (!body || typeof body.content !== "string") {
                res.writeHead(400, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "content must be a string" }));
                return;
            }
            let parsed;
            try { parsed = JSON.parse(body.content); }
            catch (e) {
                res.writeHead(400, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
                return;
            }
            const configErr = validateConfig(parsed);
            if (configErr) {
                res.writeHead(400, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: configErr }));
                return;
            }
            writeFileAtomic(configPath, body.content);
            try {
                const written = Buffer.from(body.content);
                const gz = written.length >= 1024 ? zlib.gzipSync(written) : null;
                fileCache.set(configPath, { mtime: fs.statSync(configPath).mtimeMs, data: written, gz });
            } catch (_) {}
            serverLog(ip, "config saved");
            res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            const status = e.statusCode || 500;
            console.error("POST /api/config error:", e);
            res.writeHead(status, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: status === 413 ? "Request body too large" : "Internal server error" }));
        }
        return;
    }

    // --- API: save assets ---
    if (pathname === "/api/assets" && req.method === "POST") {
        try {
            const assetsPath = path.join(DATA_DIR, "assets.json");
            if (!checkIfMatch(req, assetsPath)) {
                res.writeHead(412, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Precondition Failed: file was modified since last loaded" }));
                return;
            }
            const body = await readBody(req);
            if (!body || typeof body.content !== "string") {
                res.writeHead(400, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "content must be a string" }));
                return;
            }
            let parsed;
            try { parsed = JSON.parse(body.content); }
            catch (e) {
                res.writeHead(400, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid JSON: " + e.message }));
                return;
            }
            const assetsErr = validateAssets(parsed);
            if (assetsErr) {
                res.writeHead(400, { ...SEC_HEADERS, "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: assetsErr }));
                return;
            }
            writeFileAtomic(assetsPath, body.content);
            try {
                const written = Buffer.from(body.content);
                const gz = written.length >= 1024 ? zlib.gzipSync(written) : null;
                fileCache.set(assetsPath, { mtime: fs.statSync(assetsPath).mtimeMs, data: written, gz });
            } catch (_) {}
            serverLog(ip, "assets saved");
            res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            const status = e.statusCode || 500;
            console.error("POST /api/assets error:", e);
            res.writeHead(status, { ...SEC_HEADERS, "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: status === 413 ? "Request body too large" : "Internal server error" }));
        }
        return;
    }

    // --- Favicon ---
    if (pathname === "/favicon.ico") {
        res.writeHead(200, { ...SEC_HEADERS, "Content-Type": "image/gif", "Cache-Control": "max-age=86400" });
        res.end(FAVICON);
        return;
    }

    // --- Static file serving ---
    if (pathname === "/") pathname = "/index.html";
    if (pathname === "/index.html") serverLog(ip, "page access");

    // /data/* — allowlisted files served from data/ directory.
    // market.json is lazily converted from market.csv on each request.
    if (pathname.startsWith("/data/")) {
        const name = pathname.slice("/data/".length);
        if (!DATA_ALLOW.has(name)) {
            res.writeHead(404, SEC_HEADERS);
            res.end("Not found");
            return;
        }
        if (name === "market.json") {
            try {
                const csvPath = path.join(DATA_DIR, "market.csv");
                const stat = fs.statSync(csvPath);
                const mtime = stat.mtimeMs;
                const cached = fileCache.get(csvPath);
                let entry;
                if (cached && cached.mtime === mtime) {
                    entry = cached;
                } else {
                    const csv = fs.readFileSync(csvPath, "utf-8");
                    const data = JSON.stringify(csvToJson(csv));
                    const gz = Buffer.byteLength(data) >= 1024 ? zlib.gzipSync(data) : null;
                    entry = { mtime, data, gz };
                    fileCache.set(csvPath, entry);
                }
                sendCached(res, "application/json", entry, req);
            } catch (e) {
                if (e.code === "ENOENT") {
                    res.writeHead(404, SEC_HEADERS);
                    res.end("Not found");
                } else {
                    console.error("GET /data/market.json error:", e);
                    res.writeHead(500, SEC_HEADERS);
                    res.end("Internal server error");
                }
            }
            return;
        }
        try {
            const entry = getCachedFile(path.join(DATA_DIR, name));
            sendCached(res, "application/json", entry, req);
        } catch (e) {
            res.writeHead(404, SEC_HEADERS);
            res.end("Not found");
        }
        return;
    }

    // --- JS Bundle ---
    if (pathname === "/js/app-bundle.js") {
        try {
            const entry = getBundle();
            sendCached(res, "text/javascript", entry, req);
        } catch (e) {
            console.error("GET /js/app-bundle.js error:", e);
            res.writeHead(500, SEC_HEADERS);
            res.end("Internal server error");
        }
        return;
    }

    // Everything else — serve from app/ with path traversal protection.
    const filePath = path.resolve(path.join(APP_DIR, pathname));
    if (!filePath.startsWith(APP_DIR + path.sep)) {
        res.writeHead(403, SEC_HEADERS);
        res.end("Forbidden");
        return;
    }
    if (APP_SKIP.has(path.relative(APP_DIR, filePath))) {
        res.writeHead(404, SEC_HEADERS);
        res.end("Not found");
        return;
    }
    fs.stat(filePath, (err, stat) => {
        if (err) { res.writeHead(404, SEC_HEADERS); res.end("Not found"); return; }
        const mtime = stat.mtimeMs;
        const cached = fileCache.get(filePath);
        let entry;
        if (cached && cached.mtime === mtime) {
            entry = cached;
        } else {
            let data;
            try { data = fs.readFileSync(filePath); } catch (_) { res.writeHead(404, SEC_HEADERS); res.end("Not found"); return; }
            const gz = data.length >= 1024 ? zlib.gzipSync(data) : null;
            entry = { mtime, data, gz };
            fileCache.set(filePath, entry);
        }
        const ext = path.extname(filePath).toLowerCase();
        const extra = pathname === "/index.html" ? { "Cache-Control": "no-store" } : {};
        sendCached(res, MIME[ext] || "application/octet-stream", entry, req, extra);
    });
});

// Only start the server when run directly (not when loaded by tests).
if (require.main === module) {
    if (!DATA_DIR) {
        console.error("ERROR: DATA_DIR environment variable is not set.");
        console.error("  Demo:       DATA_DIR=./demo-data node app/serve.js");
        console.error("  Your data:  DATA_DIR=./data node app/serve.js");
        process.exit(1);
    }
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Serving on http://localhost:${PORT}`);
        if (!AUTH_ENABLED) {
            console.warn("WARNING: AUTH_PASS is not set — HTTP Basic Auth is disabled.");
            console.warn("         Set AUTH_PASS before exposing this server to a network.");
        } else if (AUTH_PASS_HASH) {
            console.log("Auth: scrypt-hashed password mode.");
        }
    });
}

module.exports = { csvToJson, prettyJson, validateTrades, validateRetirement, normalizeTrades, normalizeRetirement, validateConfig, validateAssets, getIP, AUTH_RATE, serverLog, serverWarn, sendCached, server };
