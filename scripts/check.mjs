// Listing Watch — daily RE/MAX checker (runs in GitHub Actions, Node 20+)
//
// Reads data/listings.json (your list: id + name), checks each listing on remax.com.mx,
// updates data/state.json (prices, status, history) and sends a phone alert through ntfy
// when something changed.
//
// Environment:
//   NTFY_TOPIC  your private ntfy topic name (GitHub secret)
//   APP_URL     address of the app, opened when you tap an alert
//   DRY_RUN=1   only print what was read; save nothing, send nothing
//   TEST_ALERT=1  send a test notification and stop

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LISTINGS_FILE = path.join(ROOT, "data/listings.json");
const STATE_FILE = path.join(ROOT, "data/state.json");
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const RETRY_WAIT_MS = Number(process.env.RETRY_WAIT_MS ?? 8000);
const HISTORY_LIMIT = 200;

// ---------- Parsing ----------
const decode = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
export function metaContent(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`,
    "i",
  );
  const m = html.match(re);
  const v = (m?.[1] ?? m?.[2] ?? "").trim();
  return v ? decode(v) : null;
}
export const stripTags = (html) =>
  decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const toNum = (s) => Number(String(s).replace(/,/g, ""));

// "VENTA $2,500,000 USD" is how the RE/MAX page shows the price.
export function findPriceInText(text) {
  const a = text.match(/VENTA\s*\$\s*([\d,]+(?:\.\d+)?)\s*(USD|MXN)/i);
  if (a) return { price: toNum(a[1]), currency: a[2].toUpperCase() };
  const b = text.match(/\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?)\s*(USD|MXN|DLLS?|MN)\b/i);
  if (b) return { price: toNum(b[1]), currency: /MXN|MN/i.test(b[2]) ? "MXN" : "USD" };
  return null;
}
// The page also loads its data from /ajax/FetchPropiedadFlyerData/<id>; look for a price field there.
export function findPriceInJson(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return null; }
  let price = null, currency = null;
  const walk = (o, d = 0) => {
    if (!o || typeof o !== "object" || d > 6) return;
    for (const [k, v] of Object.entries(o)) {
      if (price === null && /precio|price/i.test(k) && !/m2|metro|mant/i.test(k)) {
        const n = typeof v === "number" ? v : typeof v === "string" ? toNum(v.replace(/[^\d.,]/g, "")) : NaN;
        if (Number.isFinite(n) && n >= 1000) price = n;
      }
      if (currency === null && /moneda|currency|divisa/i.test(k) && typeof v === "string") {
        currency = /mxn|mn|peso/i.test(v) ? "MXN" : /usd|dll|d[oó]lar/i.test(v) ? "USD" : null;
      }
      if (v && typeof v === "object") walk(v, d + 1);
    }
  };
  walk(obj);
  if (price === null) return typeof obj === "string" ? findPriceInText(obj) : null;
  return { price, currency: currency ?? "USD" };
}

export async function readListing(id, fetchFn = fetch) {
  const url = `https://remax.com.mx/propiedad/${id}`;
  let res;
  try {
    res = await fetchFn(url, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": "es-MX,es;q=0.9,en;q=0.8" }, redirect: "follow" });
  } catch (e) {
    return { state: "error", reason: `network error: ${String(e?.message ?? e).slice(0, 100)}` };
  }
  if (res.status === 404 || res.status === 410) return { state: "gone", reason: `page returned ${res.status}` };
  if (!res.ok) return { state: "error", reason: `RE/MAX returned HTTP ${res.status}` };
  const finalPath = res.url ? new URL(res.url).pathname : `/propiedad/${id}`;
  if (!finalPath.includes(`/propiedad/${id}`)) return { state: "gone", reason: `redirected to ${res.url}` };

  const html = await res.text();
  const title = metaContent(html, "og:title") ?? (html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() || null);
  let found = findPriceInText(stripTags(html));
  let source = "page";
  if (!found) {
    try {
      const r = await fetchFn(`https://remax.com.mx/ajax/FetchPropiedadFlyerData/${id}`, {
        method: "POST",
        headers: {
          "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", Referer: url, Origin: "https://remax.com.mx",
          Accept: "application/json, text/javascript, */*; q=0.01",
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body: `id=${encodeURIComponent(id)}`,
      });
      if (r.ok) {
        const raw = await r.text();
        found = findPriceInJson(raw) ?? findPriceInText(stripTags(raw));
        source = "flyer-data";
      }
    } catch { /* ignore */ }
  }
  if (found && found.price > 0) return { state: "active", price: found.price, currency: found.currency, title, source };
  if (!title) return { state: "gone", reason: "page has no listing data" };
  return { state: "gone", reason: "page loaded but no price shown", title };
}

// ---------- Alerts (ntfy) ----------
export async function sendAlert({ title, message, tags = [], click }, fetchFn = fetch) {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) { console.log(`(no NTFY_TOPIC set) ALERT: ${title} — ${message}`); return false; }
  const r = await fetchFn("https://ntfy.sh/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, title, message, tags, click, priority: 4 }),
  });
  if (!r.ok) console.log(`ntfy error: HTTP ${r.status}`);
  return r.ok;
}

const fmt = (n, cur) => `$${Math.round(Number(n)).toLocaleString("en-US")} ${cur}`;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mazatlan" }); // YYYY-MM-DD

// ---------- One run ----------
export async function run({ listings, state, dryRun = false, fetchFn = fetch, appUrl = "" }) {
  const now = new Date().toISOString();
  const alerts = [];
  const report = [];
  const next = { last_run: dryRun ? state.last_run : now, listings: {} };

  for (const { id, name } of listings) {
    const prev = state.listings?.[id] ?? { status: "pending", price: null, currency: null, history: [], error_count: 0 };
    let r = await readListing(id, fetchFn);
    if (r.state !== "active") { // retry once before believing it's gone or unreachable
      await new Promise((ok) => setTimeout(ok, RETRY_WAIT_MS));
      r = await readListing(id, fetchFn);
    }
    report.push({ id, name, ...r });
    const s = { ...prev, name, last_checked: now, history: [...(prev.history ?? [])] };
    const click = appUrl ? `${appUrl}#l-${id}` : undefined;

    if (r.state === "error") {
      s.error_count = (prev.error_count ?? 0) + 1;
      s.last_error = r.reason;
      if (s.error_count === 3) {
        alerts.push({ title: `${name}: can't reach RE/MAX`, message: `3 checks in a row failed (${r.reason}). The tracker may need fixing.`, tags: ["warning"], click });
      }
    } else if (r.state === "active") {
      const first = prev.status === "pending" || prev.price == null;
      const curChanged = !first && prev.currency && prev.currency !== r.currency;
      const changed = !first && (curChanged || Number(prev.price) !== r.price);
      const cameBack = prev.status === "gone";
      Object.assign(s, { error_count: 0, last_error: null, title: r.title ?? prev.title ?? null, price: r.price, currency: r.currency, status: "active" });
      if (first || changed || cameBack) {
        s.history.push({ date: today(), price: r.price, currency: r.currency, status: "active",
          note: first ? "First check" : cameBack ? "Back on the market" : r.price < Number(prev.price) ? "Price drop" : "Price up" });
      }
      if (curChanged) {
        s.history[s.history.length - 1].note = "Price changed (currency)";
        s.last_change = now;
        s.last_change_text = `Now listed in ${r.currency}`;
        alerts.push({ title: `${name}: price changed`, message: `${fmt(prev.price, prev.currency)} → ${fmt(r.price, r.currency)} (currency changed)`, tags: ["moneybag"], click });
      } else if (changed) {
        const diff = r.price - Number(prev.price);
        const pct = Math.round((Math.abs(diff) / Number(prev.price)) * 1000) / 10;
        const down = diff < 0;
        s.last_change = now;
        s.last_change_text = `${down ? "▼" : "▲"} ${fmt(Math.abs(diff), r.currency)} (${down ? "−" : "+"}${pct}%)`;
        alerts.push({
          title: `${name}: price ${down ? "drop" : "up"}`,
          message: `${fmt(prev.price, prev.currency ?? r.currency)} → ${fmt(r.price, r.currency)} (${down ? "−" : "+"}${fmt(Math.abs(diff), r.currency)}, ${pct}%)`,
          tags: [down ? "chart_with_downwards_trend" : "chart_with_upwards_trend"], click,
        });
      } else if (cameBack) {
        s.last_change = now;
        s.last_change_text = "Back on the market";
        alerts.push({ title: `${name}: back on the market`, message: `Listed again at ${fmt(r.price, r.currency)}`, tags: ["house"], click });
      }
    } else { // gone
      s.error_count = 0;
      s.last_error = r.reason;
      if (prev.status !== "gone") {
        s.status = "gone";
        s.last_change = now;
        s.last_change_text = "Sold or removed?";
        s.history.push({ date: today(), price: null, currency: null, status: "gone", note: r.reason });
        if (prev.status !== "pending") {
          alerts.push({ title: `${name}: sold or removed?`, message: `The RE/MAX listing no longer shows a price (${r.reason}). Tap to check.`, tags: ["rotating_light"], click });
        }
      }
    }
    s.history = s.history.slice(-HISTORY_LIMIT);
    next.listings[id] = s;
  }
  return { next, alerts, report };
}

// ---------- Entry point ----------
async function main() {
  const appUrl = process.env.APP_URL ?? "";
  if (process.env.TEST_ALERT) {
    const ok = await sendAlert({ title: "Listing Watch", message: "Notifications are working ✓", tags: ["white_check_mark"], click: appUrl });
    console.log(ok ? "Test alert sent." : "Test alert NOT sent (check the NTFY_TOPIC secret).");
    return;
  }
  const listings = JSON.parse(await readFile(LISTINGS_FILE, "utf8"));
  let state = { last_run: null, listings: {} };
  try { state = JSON.parse(await readFile(STATE_FILE, "utf8")); } catch { /* first run */ }
  const dryRun = !!process.env.DRY_RUN;

  const { next, alerts, report } = await run({ listings, state, dryRun, appUrl });
  console.log("Results:\n" + JSON.stringify(report, null, 2));

  if (dryRun) { console.log(`Dry run: nothing saved. Would have sent ${alerts.length} alert(s).`); return; }
  await writeFile(STATE_FILE, JSON.stringify(next, null, 2) + "\n");

  if (alerts.length === 1) await sendAlert(alerts[0]);
  else if (alerts.length > 1) {
    await sendAlert({ title: `${alerts.length} listing changes`, message: alerts.map((a) => `• ${a.title}\n  ${a.message}`).join("\n"), tags: ["house"], click: appUrl });
  }
  console.log(`Saved. ${alerts.length} alert(s) sent.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
