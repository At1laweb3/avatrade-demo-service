// index.js — AvaTrade demo signup
// - čeka jasan ishod posle submit-a (success/error/timeout)
// - pravi screenshot-ove po fazama (ako DEBUG_SCREENSHOTS=1)
// - vraća javne URL-ove ka screenshot-ovima (/shots/<file>.png)
// - robustni klikovi + izbor države

import express from "express";
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());

// --- config ---
const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET || "superSecret123";
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG_SCREENSHOTS === "1";

// --- helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function checkAuth(req, res, next) {
  if (req.headers["x-auth"] !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

async function launchBrowser() {
  return await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1366, height: 900 },
  });
}

function ts() {
  const d = new Date();
  const s = d.toISOString().replace(/[:.]/g, "-");
  return s.slice(0, 19);
}

async function snap(page, label, shots) {
  if (!DEBUG) return null;
  const name = `${ts()}_${label}.png`;
  try {
    await page.screenshot({ path: name, fullPage: true });
    shots.push(name);
  } catch {}
  return name;
}

// JS-only klik (izbegava “Node is not clickable…”)
async function clickJS(page, selector) {
  const ok = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    const evs = ["pointerdown", "mousedown", "click", "pointerup", "mouseup"];
    for (const t of evs) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    return true;
  }, selector);
  return !!ok;
}

async function typeJS(page, selector, value) {
  return await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.focus();
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, selector, value);
}

async function openCountryDropdown(page) {
  const tries = [
    ".country-wrapper .vue-country-select .dropdown",
    ".country-wrapper .vue-country-select",
    "input[placeholder='Choose a country']",
    ".country-wrapper .selected-flag",
    ".country-wrapper"
  ];
  for (const sel of tries) {
    if (await clickJS(page, sel)) {
      await sleep(400);
      if (await page.$(".dropdown-list")) return true;
    }
  }
  await page.evaluate(() => {
    const hits = ["choose a country","country","select country"];
    const els = Array.from(document.querySelectorAll("button,div,span,input"));
    const el = els.find(e => {
      const t = ((e.textContent || e.placeholder || "") + "").toLowerCase();
      const vis = !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return vis && hits.some(h => t.includes(h));
    });
    if (el) el.click();
  });
  await sleep(400);
  return !!(await page.$(".dropdown-list"));
}

async function pickCountry(page, countryName) {
  const searchSel = ".dropdown-list input[type='search'], .dropdown-list input[role='combobox'], .dropdown-list input[aria-autocomplete='list']";
  if (await page.$(searchSel)) {
    await typeJS(page, searchSel, countryName);
    await page.keyboard.press("Enter");
    return true;
  }
  // flag za Srbiju
  if (await page.$(".dropdown-list li.dropdown-item .vti__flag.rs")) {
    await clickJS(page, ".dropdown-list li.dropdown-item .vti__flag.rs");
    return true;
  }
  // scroll + tekst
  const names = [countryName, "Serbia (Србија)"];
  const ok = await page.evaluate((names) => {
    const list = document.querySelector(".dropdown-list") || document.body;
    function vis(el){ return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); }
    for (let p=0; p<80; p++) {
      const items = Array.from(list.querySelectorAll("li.dropdown-item, li, div.dropdown-item")).filter(vis);
      const target = items.find(it => {
        const txt = (it.textContent || "").trim().toLowerCase();
        return names.some(n => txt.includes(n.toLowerCase()));
      });
      if (target) { target.click(); return true; }
      list.scrollBy(0, 260);
    }
    return false;
  }, names);
  return !!ok;
}

async function extractPageInfo(page) {
  const text = await page.evaluate(() => document.body ? document.body.innerText : "");
  const excerpt = (text || "").replace(/\s+/g, " ").slice(0, 2000);
  const out = { found: false, login: null, server: null, password: null, excerpt };
  if (!text) return out;

  const loginMatch = text.match(/(?:MT[45]\s*login|Account|Login)\s*[:\-]?\s*(\d{6,12})/i);
  const serverMatch = text.match(/Server\s*[:\-]?\s*([A-Za-z0-9._\-\s]+?(?:Demo|Live)?)/i);
  const passMatch = text.match(/Password\s*[:\-]?\s*([^\s\r\n]+)/i);

  if (loginMatch) out.login = loginMatch[1];
  if (serverMatch) out.server = serverMatch[1].trim();
  if (passMatch) out.password = passMatch[1];
  if (out.login && out.server) out.found = true;
  return out;
}

// čekaj jasan ishod do maxMs
async function waitForOutcome(page, maxMs = 60000) {
  const start = Date.now();
  const SUCCESS = [
    /congratulations/i,
    /account application has been approved/i,
    /webtrader login details/i,
    /trade on demo/i,
    /login details and platforms/i
  ];
  const ERROR = [
    /error/i, /incorrect/i, /already used/i, /already exists/i,
    /try again/i, /protection/i, /blocked/i, /robot/i, /captcha/i, /too many/i,
    /not valid/i, /invalid/i
  ];
  let lastText = "";

  while (Date.now() - start < maxMs) {
    const text = await page.evaluate(() => document.body ? document.body.innerText : "");
    lastText = (text || "");
    if (SUCCESS.some(r => r.test(lastText))) return { status: "success", text: lastText.slice(0, 2000) };
    if (ERROR.some(r => r.test(lastText)))   return { status: "error",   text: lastText.slice(0, 2000) };
    await sleep(1500);
  }
  return { status: "timeout", text: lastText.slice(0, 2000) };
}

// ---------- routes ----------
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, country = "Serbia" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok:false, error:"Missing fields" });

  let browser, phase = "init";
  // skladištimo imena screenshotova
  const shots = [];

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(45000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase = "goto";   log("PHASE:", phase);
    await page.goto("https://www.avatrade.com/demo-account", { waitUntil: "networkidle2", timeout: 60000 });
    await snap(page, "01_goto", shots);
    await sleep(800);

    phase = "cookies";   log("PHASE:", phase);
    await page.evaluate(() => {
      const texts = ["accept","accept all","i agree","got it","not now","close"];
      const els = Array.from(document.querySelectorAll("button,a"));
      const el = els.find(e => {
        const t = (e.textContent || "").toLowerCase();
        return texts.some(x => t.includes(x));
      });
      if (el) el.click();
    });

    phase = "fill";   log("PHASE:", phase);
    await page.waitForSelector("#input-email");
    await page.waitForSelector("#input-password");
    await typeJS(page, "#input-email", email);
    await typeJS(page, "#input-password", password);
    await snap(page, "02_filled", shots);

    phase = "country-open";   log("PHASE:", phase);
    const opened = await openCountryDropdown(page);
    if (!opened) throw new Error("Country dropdown not opened");

    phase = "country-pick";   log("PHASE:", phase);
    const picked = await pickCountry(page, country);
    if (!picked) throw new Error(`Country '${country}' not selected`);
    await snap(page, "03_country", shots);

    phase = "submit";   log("PHASE:", phase);
    await page.evaluate(() => {
      const e = document.querySelector("#input-email");
      const p = document.querySelector("#input-password");
      for (const el of [e,p]) {
        if (!el) continue;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
      }
    });
    await sleep(400);
    await page.evaluate(() => { const b = document.querySelector("button[type='submit']"); if (b) b.removeAttribute("disabled"); });
    await clickJS(page, "button[type='submit']");
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
      sleep(8000)
    ]);
    await snap(page, "04_after_submit", shots);

    phase = "outcome";   log("PHASE:", phase);
    const outcome = await waitForOutcome(page, 60000); // success/error/timeout
    await snap(page, `05_outcome_${outcome.status}`, shots);

    phase = "extract";   log("PHASE:", phase);
    const mt = await extractPageInfo(page);

    // formiraj javne URL-ove ka screenshotovima
    const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map((f) => `${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok: outcome.status === "success",
      note: `Outcome: ${outcome.status}`,
      url: page.url(),
      outcome_excerpt: outcome.text.slice(0, 500),
      mt_login: mt.login,
      mt_server: mt.server,
      mt_password: mt.password || password,
      page_excerpt: mt.excerpt,
      screenshots: screenshot_urls
    });

  } catch (e) {
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error: String(e), phase });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

// health
app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));

// **serve screenshots** (samo .png iz radnog direktorijuma)
app.use("/shots", (req, res, next) => {
  const filename = req.path.replace(/^\/+/, "");
  if (!/\.png$/i.test(filename)) return res.status(400).send("bad file");
  const full = path.join(process.cwd(), filename);
  if (!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

app.listen(PORT, () => console.log("Listening on", PORT));