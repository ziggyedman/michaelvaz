const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Auth ──────────────────────────────────────────────────────
// Configure users via USERS env var: "alice:pass1,bob:pass2"
// Defaults to admin:admin for local development
function parseUsers(str) {
  const map = {};
  for (const pair of str.split(",")) {
    const idx = pair.indexOf(":");
    if (idx < 1) continue;
    map[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return map;
}
const USERS = parseUsers(process.env.USERS || "admin:admin");
const sessions = new Map(); // token → username

function requireAuth(req, res, next) {
  const token = req.headers["x-session-token"];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: "Unauthorized" });
  req.user = sessions.get(token);
  next();
}

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || USERS[username] !== password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = crypto.randomUUID();
  sessions.set(token, username);
  return res.json({ token, username });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.headers["x-session-token"];
  if (token) sessions.delete(token);
  return res.json({ ok: true });
});

// ── Email: Send ────────────────────────────────────────────────────────────────
app.post("/api/send", requireAuth, async (req, res) => {
  const { apiKey, from, to, subject, html } = req.body;
  if (!apiKey || !from || !to || !subject || !html) {
    return res.status(400).json({ error: "Missing required fields: apiKey, from, to, subject, html" });
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    return res.json({ success: true, data });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
});

// ── Email: List Resend account templates ───────────────────────
app.get("/api/templates", requireAuth, async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });
  try {
    const response = await fetch("https://api.resend.com/templates", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
});

// ── Email: Get single Resend template ──────────────────────────
app.get("/api/templates/:id", requireAuth, async (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(400).json({ error: "Missing x-api-key header" });
  try {
    const response = await fetch(`https://api.resend.com/templates/${req.params.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data });
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
});

// ── DNS Lookup via Google DNS-over-HTTPS ───────────────────────
const DNS_TYPE_CODES = {
  A: 1, AAAA: 28, MX: 15, TXT: 16, CNAME: 5, NS: 2, SOA: 6,
  SRV: 33, PTR: 12, CAA: 257, NAPTR: 35, DNSKEY: 48, DS: 43,
};

async function queryDNS(domain, type) {
  const typeCode = DNS_TYPE_CODES[type] || type;
  const url = `https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${typeCode}`;
  const t0 = Date.now();
  try {
    const response = await fetch(url, { headers: { Accept: "application/dns-json" } });
    const data = await response.json();
    return { type, status: data.Status, records: data.Answer || [], authority: data.Authority || [], elapsed: Date.now() - t0, raw: data };
  } catch (err) {
    return { type, status: -1, records: [], authority: [], elapsed: Date.now() - t0, error: err.message };
  }
}

function parseDnsRecords(records, type) {
  return records
    .filter(r => { const code = DNS_TYPE_CODES[type]; return code ? r.type === code : true; })
    .map(r => {
      const base = { name: r.name, ttl: r.TTL, raw: r.data };
      switch (type) {
        case "MX": { const p = (r.data || "").split(/\s+/); return { ...base, priority: parseInt(p[0]) || 0, exchange: p[1] || r.data }; }
        case "SOA": { const p = (r.data || "").split(/\s+/); return { ...base, mname: p[0], rname: p[1], serial: +p[2]||0, refresh: +p[3]||0, retry: +p[4]||0, expire: +p[5]||0, minimum: +p[6]||0 }; }
        case "SRV": { const p = (r.data || "").split(/\s+/); return { ...base, priority: +p[0]||0, weight: +p[1]||0, port: +p[2]||0, target: p[3]||"" }; }
        case "CAA": { const p = (r.data || "").split(/\s+/); return { ...base, flags: +p[0]||0, tag: p[1]||"", value: p.slice(2).join(" ").replace(/"/g,"") }; }
        default: return { ...base, value: r.data };
      }
    });
}

app.get("/api/dns", requireAuth, async (req, res) => {
  const { domain, type = "ANY" } = req.query;
  if (!domain) return res.status(400).json({ error: "Missing domain query parameter" });
  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  const t0 = Date.now();

  if (type === "ANY") {
    const typesToQuery = ["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SOA", "CAA"];
    const queries = await Promise.all(typesToQuery.map(t => queryDNS(cleanDomain, t)));
    const results = {}, errors = {}, timing = {};
    for (const q of queries) {
      timing[q.type] = q.elapsed;
      if (q.error) { errors[q.type] = q.error; }
      else if (q.status !== 0 && q.records.length === 0) {
        const m = { 0:"NOERROR",1:"FORMERR",2:"SERVFAIL",3:"NXDOMAIN",5:"REFUSED" };
        errors[q.type] = m[q.status] || `DNS_STATUS_${q.status}`;
      } else {
        const parsed = parseDnsRecords(q.records, q.type);
        if (parsed.length > 0) results[q.type] = parsed; else errors[q.type] = "ENODATA";
      }
    }
    return res.json({ domain: cleanDomain, type: "ANY", results, errors, timing, elapsed: Date.now()-t0, resolver: "dns.google" });
  }

  if (!DNS_TYPE_CODES[type]) return res.status(400).json({ error: `Unsupported type: ${type}` });
  const q = await queryDNS(cleanDomain, type);
  if (q.error) return res.json({ domain: cleanDomain, type, results: {}, errors: { [type]: q.error }, timing: { [type]: q.elapsed }, elapsed: q.elapsed, resolver: "dns.google" });
  const parsed = parseDnsRecords(q.records, type);
  if (parsed.length > 0) return res.json({ domain: cleanDomain, type, results: { [type]: parsed }, errors: {}, timing: { [type]: q.elapsed }, elapsed: q.elapsed, resolver: "dns.google" });
  return res.json({ domain: cleanDomain, type, results: {}, errors: { [type]: "ENODATA" }, timing: { [type]: q.elapsed }, elapsed: q.elapsed, resolver: "dns.google" });
});

// ── SPF / DKIM / DMARC Diagnostics ────────────────────────────
app.get("/api/dns/email-diag", requireAuth, async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: "Missing domain parameter" });
  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  const t0 = Date.now();

  const [mxR, txtR, dmarcR, dkimR] = await Promise.all([
    queryDNS(cleanDomain, "MX"), queryDNS(cleanDomain, "TXT"),
    queryDNS(`_dmarc.${cleanDomain}`, "TXT"), queryDNS(`default._domainkey.${cleanDomain}`, "TXT"),
  ]);

  const mx = parseDnsRecords(mxR.records, "MX");
  const allTxt = parseDnsRecords(txtR.records, "TXT");
  const spf = allTxt.filter(r => (r.value||"").startsWith("v=spf1"));
  const dmarc = parseDnsRecords(dmarcR.records, "TXT").filter(r => (r.value||"").startsWith("v=DMARC1"));
  const dkim = parseDnsRecords(dkimR.records, "TXT").filter(r => (r.value||"").startsWith("v=DKIM1"));

  const checks = [];
  checks.push(mx.length > 0
    ? { test: "MX Records", status: "pass", detail: `${mx.length} MX record(s) found`, records: mx }
    : { test: "MX Records", status: "fail", detail: "No MX records — domain cannot receive email" });

  if (spf.length === 1) {
    const v = spf[0].value||""; const ok = v.includes("-all") || v.includes("~all");
    checks.push({ test: "SPF Record", status: ok?"pass":"warn", detail: ok?"SPF with proper enforcement":"SPF missing -all or ~all", records: spf });
  } else if (spf.length > 1) { checks.push({ test: "SPF Record", status: "warn", detail: `${spf.length} SPF records — only one allowed`, records: spf });
  } else { checks.push({ test: "SPF Record", status: "fail", detail: "No SPF record found" }); }

  if (dmarc.length > 0) {
    const p = (dmarc[0].value||"").match(/p=(\w+)/); const pv = p?p[1]:"none";
    checks.push({ test: "DMARC Record", status: pv==="reject"?"pass":"warn", detail: `DMARC policy: ${pv}`, records: dmarc });
  } else { checks.push({ test: "DMARC Record", status: "fail", detail: "No DMARC record at _dmarc."+cleanDomain }); }

  checks.push(dkim.length > 0
    ? { test: "DKIM (default selector)", status: "pass", detail: "DKIM public key found", records: dkim }
    : { test: "DKIM (default selector)", status: "info", detail: "No DKIM at default._domainkey — try your provider's selector" });

  return res.json({ domain: cleanDomain, checks, elapsed: Date.now()-t0, resolver: "dns.google" });
});

app.listen(PORT, () => {
  console.log(`\n  ✉  Resend Support Toolkit`);
  console.log(`  →  http://localhost:${PORT}\n`);
  console.log(`  Users: ${Object.keys(USERS).join(", ")}\n`);
});
