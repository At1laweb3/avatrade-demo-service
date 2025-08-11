// index.js — AvaTrade demo signup (debug phases + JS-only clicks)

import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET || "superSecret123";
const PORT = process.env.PORT || 3000;

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

// ---------- helpers ----------
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
  // više pokušaja
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
      const opened = await page.$(".dropdown-list");
      if (opened) return true;
    }
  }
  // probaj preko teksta
  await page.evaluate(() => {
    const textHits = ["choose a country","country","select country"];
    const els = Array.from(document.querySelectorAll("button,div,span,input"));
    const el = els.find(e => {
      const t = ((e.textContent || e.placeholder || "") + "").toLowerCase();
      const vis = !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return vis && textHits.some(h => t.includes(h));
    });
    if (el) el.click();
  });
  await sleep(400);
  return !!(await page.$(".dropdown-list"));
}

async function pickCountry(page, countryName) {
  // 1) search u listi
  const searchSel = ".dropdown-list input[type='search'], .dropdown-list input[role='combobox'], .dropdown-list input[aria-autocomplete='list']";
  const hasSearch = await page.$(searchSel);
  if (hasSearch) {
    await typeJS(page, searchSel, countryName);
    await page.keyboard.press("Enter");
    return true;
  }
  // 2) flag za Srbiju
  if (await page.$(".dropdown-list li.dropdown-item .vti__flag.rs")) {
    await clickJS(page, ".dropdown-list li.dropdown-item .vti__flag.rs");
    return true;
  }
  // 3) skrol + klik po tekstu
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
  const excerpt = (text || "").replace(/\s+/g, " ").slice(0, 1200);
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

// ---------- route ----------
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, country = "Serbia" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok:false, error:"Missing fields" });

  let browser, phase = "init";
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(45000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase = "goto";
    log("PHASE:", phase);
    await page.goto("https://www.avatrade.com/demo-account", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(800);

    phase = "cookies";
    log("PHASE:", phase);
    await page.evaluate(() => {
      const texts = ["accept","accept all","i agree","got it","not now","close"];
      const els = Array.from(document.querySelectorAll("button,a"));
      const el = els.find(e => {
        const t = (e.textContent || "").toLowerCase();
        return texts.some(x => t.includes(x));
      });
      if (el) el.click();
    });

    phase = "fill";
    log("PHASE:", phase);
    await page.waitForSelector("#input-email");
    await page.waitForSelector("#input-password");
    await typeJS(page, "#input-email", email);
    await typeJS(page, "#input-password", password);

    phase = "country-open";
    log("PHASE:", phase);
    const opened = await openCountryDropdown(page);
    if (!opened) throw new Error("Country dropdown not opened");

    phase = "country-pick";
    log("PHASE:", phase);
    const picked = await pickCountry(page, country);
    if (!picked) throw new Error(`Country '${country}' not selected`);
    await sleep(300);

    phase = "submit";
    log("PHASE:", phase);
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
    // oslobodi dugme i klikni JS-om
    await page.evaluate(() => { const b = document.querySelector("button[type='submit']"); if (b) b.removeAttribute("disabled"); });
    await clickJS(page, "button[type='submit']");
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
      sleep(8000)
    ]);

    phase = "extract";
    log("PHASE:", phase);
    const mt = await extractPageInfo(page);
    try { await page.screenshot({ path: "after_submit.png", fullPage: true }); } catch {}

    return res.json({
      ok: true,
      note: "Submit executed",
      url: page.url(),
      mt_login: mt.login,
      mt_server: mt.server,
      mt_password: mt.password || password,
      page_excerpt: mt.excerpt,
    });

  } catch (e) {
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error: String(e), phase });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));
app.listen(PORT, () => console.log("Listening on", PORT));