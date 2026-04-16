const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const fs = require("fs");

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

// ── React Email Templates (from react.email/templates) ────────
// Paths are relative to apps/demo/emails/ in the react-email canary branch.
// Community/ = real-world brand replicas  |  0x-* = design-system sets
const REACT_EMAIL_TEMPLATES = [
  // ── Magic Links ───────────────────────────────────────────────
  { name: "AWS / Verify Email",            path: "Community/magic-links/aws-verify-email" },
  { name: "Slack / Confirm Email",         path: "Community/magic-links/slack-confirm" },
  { name: "Notion / Magic Link",           path: "Community/magic-links/notion-magic-link" },
  { name: "Linear / Login Code",           path: "Community/magic-links/linear-login-code" },
  { name: "Raycast / Magic Link",          path: "Community/magic-links/raycast-magic-link" },
  { name: "Plaid / Verify Identity",       path: "Community/magic-links/plaid-verify-identity" },
  // ── Notifications ─────────────────────────────────────────────
  { name: "GitHub / Access Token",         path: "Community/notifications/github-access-token" },
  { name: "Vercel / Invite User",          path: "Community/notifications/vercel-invite-user" },
  { name: "Yelp / Recent Login",           path: "Community/notifications/yelp-recent-login" },
  { name: "Papermark / Year in Review",    path: "Community/notifications/papermark-year-in-review" },
  // ── Receipts ──────────────────────────────────────────────────
  { name: "Apple / Receipt",               path: "Community/receipts/apple-receipt" },
  { name: "Nike / Receipt",                path: "Community/receipts/nike-receipt" },
  // ── Newsletters ───────────────────────────────────────────────
  { name: "Stack Overflow / Tips",         path: "Community/newsletters/stack-overflow-tips" },
  { name: "Google Play / Policy Update",   path: "Community/newsletters/google-play-policy-update" },
  { name: "Codepen / Challengers",         path: "Community/newsletters/codepen-challengers" },
  // ── Reset Password ────────────────────────────────────────────
  { name: "Twitch / Reset Password",       path: "Community/reset-password/twitch-reset-password" },
  { name: "Dropbox / Reset Password",      path: "Community/reset-password/dropbox-reset-password" },
  // ── Reviews ───────────────────────────────────────────────────
  { name: "Airbnb / Review",               path: "Community/reviews/airbnb-review" },
  { name: "Amazon / Review",               path: "Community/reviews/amazon-review" },
  // ── Welcome ───────────────────────────────────────────────────
  { name: "Koala / Welcome",               path: "Community/welcome/koala-welcome" },
  { name: "Stripe / Welcome",              path: "Community/welcome/stripe-welcome" },
  { name: "Netlify / Welcome",             path: "Community/welcome/netlify-welcome" },
  // ── Design Systems ────────────────────────────────────────────
  { name: "Barebone / Activation",         path: "01-Barebone/activation" },
  { name: "Barebone / Welcome",            path: "01-Barebone/welcome" },
  { name: "Barebone / Password Reset",     path: "01-Barebone/password-reset" },
  { name: "Barebone / Feature Announcement", path: "01-Barebone/feature-announcement" },
  { name: "Barebone / Product Update",     path: "01-Barebone/product-update" },
  { name: "Matte / Activation",            path: "02-Matte/activation" },
  { name: "Matte / Welcome",               path: "02-Matte/welcome" },
  { name: "Matte / Password Reset",        path: "02-Matte/password-reset" },
  { name: "Protocol / Activation",         path: "03-Protocol/activation" },
  { name: "Protocol / Welcome",            path: "03-Protocol/welcome" },
  { name: "Arcane / Activation",           path: "04-Arcane/activation" },
  { name: "Arcane / Welcome",              path: "04-Arcane/welcome" },
  { name: "Arcane / Order Confirmation",   path: "04-Arcane/order-confirmation" },
  { name: "Studio / Activation",           path: "05-Studio/activation" },
  { name: "Studio / Welcome",              path: "05-Studio/welcome" },
  { name: "Studio / Order Confirmation",   path: "05-Studio/order-confirmation" },
];

app.get("/api/react-email-templates", requireAuth, (req, res) => {
  res.json({ templates: REACT_EMAIL_TEMPLATES });
});

// ── React Email: fetch + render a template to HTML ────────────
const _tplCache = new Map(); // path → { html, at }
const _TPL_TTL  = 3600 * 1000; // 1 hour

async function renderReactEmailTemplate(tsxSource, cacheKey) {
  const hit = _tplCache.get(cacheKey);
  if (hit && Date.now() - hit.at < _TPL_TTL) return hit.html;

  const esbuild = require("esbuild");
  const React   = require("react");
  const { render } = require("@react-email/render");

  const buildResult = await esbuild.build({
    stdin: { contents: tsxSource, loader: "tsx", resolveDir: __dirname },
    bundle:   true,
    format:   "cjs",
    write:    false,
    platform: "node",
    target:   "node18",
    logLevel: "silent",
    jsx:      "automatic",
    plugins: [{
      name: "email-shims",
      setup(build) {
        // Templates import from 'react-email' → alias to installed @react-email/components
        build.onResolve({ filter: /^react-email$/ }, () => ({
          path: require.resolve("@react-email/components"),
        }));
        // Mock the relative tailwind.config import (custom fonts/colors – not needed for preview)
        build.onResolve({ filter: /tailwind\.config/ }, () => ({
          path: "tw-cfg-shim", namespace: "virtual",
        }));
        build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
          contents: "module.exports = {}", loader: "js",
        }));
      },
    }],
  });

  // Write bundle to a temp file and require it (more reliable than vm)
  const tmpPath = path.join(os.tmpdir(), `rse-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(tmpPath, buildResult.outputFiles[0].text);

  let html;
  try {
    delete require.cache[tmpPath];
    const mod = require(tmpPath);
    const Component = mod.default ?? Object.values(mod).find(v => typeof v === "function");
    if (typeof Component !== "function") throw new Error("No React component found in template");
    html = await Promise.resolve(render(React.createElement(Component), { pretty: true }));
  } finally {
    setTimeout(() => { try { delete require.cache[tmpPath]; fs.unlinkSync(tmpPath); } catch {} }, 2000);
  }

  _tplCache.set(cacheKey, { html, at: Date.now() });
  return html;
}

app.get("/api/react-email-templates/source", requireAuth, async (req, res) => {
  const { path: tplPath } = req.query;
  if (!tplPath) return res.status(400).json({ error: "Missing path" });

  const apiUrl = `https://api.github.com/repos/resend/react-email/contents/apps/demo/emails/${tplPath}.tsx?ref=canary`;
  const rawUrl = `https://raw.githubusercontent.com/resend/react-email/canary/apps/demo/emails/${tplPath}.tsx`;

  try {
    let source = null;

    // Primary: GitHub Contents API (works from cloud servers, avoids raw CDN blocks)
    const apiRes = await fetch(apiUrl, {
      headers: { "User-Agent": "resend-toolkit", "Accept": "application/vnd.github.v3+json" },
    });
    if (apiRes.ok) {
      const json = await apiRes.json();
      source = Buffer.from(json.content, "base64").toString("utf-8");
    } else {
      // Fallback: raw CDN
      const rawRes = await fetch(rawUrl, { headers: { "User-Agent": "resend-toolkit" } });
      if (!rawRes.ok) {
        return res.status(404).json({ error: `Template not found: ${tplPath} (GitHub ${rawRes.status})` });
      }
      source = await rawRes.text();
    }

    const html = await renderReactEmailTemplate(source, tplPath);
    return res.json({ html, rawUrl });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── TSX → HTML Converter ──────────────────────────────────────
function tailwindToInline(classes) {
  if (!classes) return "";
  const s = [];
  for (const c of classes.split(/\s+/)) {
    // Text color
    const tcm = c.match(/^text-\[(#[0-9a-fA-F]+)\]$/); if (tcm) { s.push(`color:${tcm[1]}`); continue; }
    // Background color
    const bgm = c.match(/^bg-\[(#[0-9a-fA-F]+)\]$/); if (bgm) { s.push(`background-color:${bgm[1]}`); continue; }
    if (c === "bg-white") { s.push("background-color:#fff"); continue; }
    if (c === "bg-black") { s.push("background-color:#000"); continue; }
    // Font size bracket
    const fsm = c.match(/^text-\[(\d+)px\]$/); if (fsm) { s.push(`font-size:${fsm[1]}px`); continue; }
    // Font size named
    const fss = {xs:"12px",sm:"14px",base:"16px",lg:"18px",xl:"20px"};
    if (fss[c.replace("text-","")]) { s.push(`font-size:${fss[c.replace("text-","")]}`); continue; }
    const fsx = c.match(/^text-(\d)xl$/); if (fsx) { s.push(`font-size:${12 + parseInt(fsx[1]) * 8}px`); continue; }
    // Text align
    if (c === "text-center") { s.push("text-align:center"); continue; }
    if (c === "text-left") { s.push("text-align:left"); continue; }
    if (c === "text-right") { s.push("text-align:right"); continue; }
    // Font weight
    const fw = {bold:"bold","semibold":"600","medium":"500","light":"300","normal":"400"};
    const fwm = c.match(/^font-(.+)$/); if (fwm && fw[fwm[1]]) { s.push(`font-weight:${fw[fwm[1]]}`); continue; }
    // Text decoration
    if (c === "underline") { s.push("text-decoration:underline"); continue; }
    if (c === "no-underline") { s.push("text-decoration:none"); continue; }
    if (c === "uppercase") { s.push("text-transform:uppercase"); continue; }
    // Leading
    const ldm = c.match(/^leading-\[(\d+)px\]$/); if (ldm) { s.push(`line-height:${ldm[1]}px`); continue; }
    if (c === "leading-tight") { s.push("line-height:1.25"); continue; }
    if (c === "leading-normal") { s.push("line-height:1.5"); continue; }
    // Margin / padding (numeric)
    const spm = c.match(/^([mp])([trblxy])?-(\d+\.?\d*)$/);
    if (spm) {
      const prop = spm[1]==="m"?"margin":"padding", v = parseFloat(spm[3])*4+"px";
      const d = {t:"-top",r:"-right",b:"-bottom",l:"-left"}[spm[2]];
      if (d) s.push(`${prop}${d}:${v}`);
      else if (spm[2]==="x") { s.push(`${prop}-left:${v}`); s.push(`${prop}-right:${v}`); }
      else if (spm[2]==="y") { s.push(`${prop}-top:${v}`); s.push(`${prop}-bottom:${v}`); }
      else s.push(`${prop}:${v}`);
      continue;
    }
    // Margin/padding bracket
    const spb = c.match(/^([mp])([trblxy])?-\[(.+)\]$/);
    if (spb) {
      const prop = spb[1]==="m"?"margin":"padding", v = spb[3];
      const d = {t:"-top",r:"-right",b:"-bottom",l:"-left"}[spb[2]];
      if (d) s.push(`${prop}${d}:${v}`);
      else if (spb[2]==="x") { s.push(`${prop}-left:${v}`); s.push(`${prop}-right:${v}`); }
      else if (spb[2]==="y") { s.push(`${prop}-top:${v}`); s.push(`${prop}-bottom:${v}`); }
      else s.push(`${prop}:${v}`);
      continue;
    }
    if (c === "mx-auto") { s.push("margin-left:auto","margin-right:auto"); continue; }
    // Width
    if (c === "w-full") { s.push("width:100%"); continue; }
    const wm = c.match(/^w-\[(.+)\]$/); if (wm) { s.push(`width:${wm[1]}`); continue; }
    const mwm = c.match(/^max-w-\[(.+)\]$/); if (mwm) { s.push(`max-width:${mwm[1]}`); continue; }
    // Display
    if (c === "block") { s.push("display:block"); continue; }
    if (c === "inline-block") { s.push("display:inline-block"); continue; }
    if (c === "hidden") { s.push("display:none"); continue; }
    if (c === "flex") { s.push("display:flex"); continue; }
    // Border radius
    if (c === "rounded") { s.push("border-radius:4px"); continue; }
    if (c === "rounded-md") { s.push("border-radius:6px"); continue; }
    if (c === "rounded-lg") { s.push("border-radius:8px"); continue; }
    if (c === "rounded-full") { s.push("border-radius:9999px"); continue; }
    const rrm = c.match(/^rounded-\[(.+)\]$/); if (rrm) { s.push(`border-radius:${rrm[1]}`); continue; }
    // Border
    if (c === "border") { s.push("border-width:1px"); continue; }
    if (c === "border-solid") { s.push("border-style:solid"); continue; }
    const bcm = c.match(/^border-\[(#[0-9a-fA-F]+)\]$/); if (bcm) { s.push(`border-color:${bcm[1]}`); continue; }
  }
  return s.join(";");
}

function convertTsxToHtml(tsx) {
  let jsx = tsx;

  // Extract JSX: from first <Html to last </Html>
  const htmlStart = jsx.indexOf("<Html");
  const htmlEnd = jsx.lastIndexOf("</Html>");
  if (htmlStart !== -1 && htmlEnd !== -1) {
    jsx = jsx.substring(htmlStart, htmlEnd + "</Html>".length);
  } else {
    // Fallback: try to find returned JSX
    const m = tsx.match(/=>\s*\(\s*([\s\S]*?)\s*\)\s*;/);
    if (m) jsx = m[1];
  }

  // Component → HTML tag map
  const tags = {
    Html:"html", Head:"head", Body:"body", Text:"p", Heading:"h1",
    Link:"a", Img:"img", Hr:"hr", CodeBlock:"pre", CodeInline:"code",
  };
  const wrappers = { Container:"div", Section:"div", Row:"div", Column:"div" };
  const stripTags = ["Tailwind","Font","Preview"];

  // Strip wrapper-only tags (Tailwind, Font, Preview)
  for (const t of stripTags) {
    jsx = jsx.replace(new RegExp(`<${t}[^>]*>`, "g"), "");
    jsx = jsx.replace(new RegExp(`</${t}>`, "g"), "");
  }

  // Replace component tags
  function replaceTag(comp, htmlTag, extraStyle) {
    // Self-closing
    jsx = jsx.replace(new RegExp(`<${comp}\\b([^>]*?)\\s*/>`, "g"), (_, a) => `<${htmlTag}${processAttrs(a, extraStyle)} />`);
    // Opening
    jsx = jsx.replace(new RegExp(`<${comp}\\b([^>]*?)>`, "g"), (_, a) => `<${htmlTag}${processAttrs(a, extraStyle)}>`);
    // Closing
    jsx = jsx.replace(new RegExp(`</${comp}>`, "g"), `</${htmlTag}>`);
  }

  function processAttrs(attrs, extraStyle) {
    let a = attrs;
    let collectedStyles = extraStyle ? [extraStyle] : [];

    // className → Tailwind inline styles
    a = a.replace(/className="([^"]*)"/g, (_, cls) => {
      const tw = tailwindToInline(cls);
      if (tw) collectedStyles.push(tw);
      return "";
    });

    // JSX style objects: style={{ key: "val" }}
    a = a.replace(/style=\{\{([^}]*)\}\}/g, (_, inner) => {
      const css = inner.split(",").map(pair => {
        const [k, ...rest] = pair.split(":"); if (!k) return "";
        const prop = k.trim().replace(/["']/g,"").replace(/([A-Z])/g,"-$1").toLowerCase();
        const val = rest.join(":").trim().replace(/["']/g,"").replace(/,\s*$/,"");
        return val ? `${prop}:${val}` : "";
      }).filter(Boolean).join(";");
      if (css) collectedStyles.push(css);
      return "";
    });

    // Config props (like config={...}) — remove
    a = a.replace(/\s+config=\{[^}]*\}/g, "");

    // Template expressions in attribute values
    a = a.replace(/=\{`\$\{baseUrl\}([^`]*)`\}/g, '="https://react.email$1"');
    a = a.replace(/=\{`([^`]*)`\}/g, '="$1"');
    a = a.replace(/=\{([a-zA-Z_]+)\}/g, '="{{$1}}"');
    a = a.replace(/=\{[^}]+\}/g, '=""');

    // Merge styles
    if (collectedStyles.length) {
      const merged = collectedStyles.join(";").replace(/;+/g, ";").replace(/;$/, "");
      // If there's already a style attr, merge
      if (a.includes('style="')) {
        a = a.replace(/style="([^"]*)"/, (_, ex) => `style="${ex};${merged}"`);
      } else {
        a += ` style="${merged}"`;
      }
    }
    return a;
  }

  // Simple tags
  for (const [comp, tag] of Object.entries(tags)) replaceTag(comp, tag, "");
  // Wrapper divs
  replaceTag("Container", "div", "max-width:600px;margin:0 auto;padding:0 12px");
  replaceTag("Button", "a", "display:inline-block;padding:12px 20px;background:#000;color:#fff;text-decoration:none;border-radius:5px;font-weight:600");
  for (const [comp, tag] of Object.entries(wrappers)) {
    if (comp !== "Container") replaceTag(comp, tag, "");
  }

  // Handle lowercase JSX tags with className (like <code className=...>)
  jsx = jsx.replace(/className="([^"]*)"/g, (_, cls) => {
    const tw = tailwindToInline(cls);
    return tw ? `style="${tw}"` : `class="${cls}"`;
  });

  // Replace inline JSX expressions
  jsx = jsx.replace(/\{loginCode\}/g, "sparo-ndigo-amurt-secan");
  jsx = jsx.replace(/\{validationCode\}/g, "DJZ-TLX");
  jsx = jsx.replace(/\{`\$\{baseUrl\}([^`]*)`\}/g, "https://react.email$1");
  jsx = jsx.replace(/\{[a-zA-Z_.]+\}/g, "{{placeholder}}");
  jsx = jsx.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  jsx = jsx.replace(/\{[\s\S]{30,}?\}/g, "<!-- dynamic content -->");
  jsx = jsx.replace(/&apos;/g, "'");

  // Clean up
  jsx = jsx.replace(/\n{3,}/g, "\n\n").trim();
  if (!jsx.startsWith("<!DOCTYPE") && !jsx.startsWith("<html")) jsx = `<!DOCTYPE html>\n${jsx}`;
  return jsx;
}

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
