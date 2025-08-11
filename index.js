// index.js — AvaTrade demo signup (robust clicks + country select + submit fallbacks)

import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET || "superSecret123";
const PORT = process.env.PORT || 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---------- HELPERI ----------
async function safeClick(page, selector) {
  const el = await page.$(selector);
  if (!el) return false;
  try {
    await el.evaluate((e) => e.scrollIntoView({ block: "center", inline: "center" }));
  } catch {}
  try {
    await el.click({ delay: 40 });
    return true;
  } catch {
    try {
      await page.evaluate((e) => e && e.click(), el);
      return true;
    } catch {
      return false;
    }
  }
}

async function clickByTextVisible(page, selector, texts) {
  return await page.evaluate(({ selector, texts }) => {
    const lows = texts.map((t) => t.toLowerCase());
    const els = Array.from(document.querySelectorAll(selector));
    const el = els.find((e) => {
      const txt = ((e.textContent || e.getAttribute("placeholder") || "") + "").toLowerCase().trim();
      const vis = !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return vis && lows.some((t) => txt.includes(t));
    });
    if (el) { el.click(); return true; }
    return false;
  }, { selector, texts });
}

async function openCountryDropdown(page) {
  const tries = [
    ".country-wrapper .vue-country-select .dropdown",
    ".country-wrapper .vue-country-select input",
    "input[placeholder='Choose a country']",
    ".country-wrapper .selected-flag",
    ".country-wrapper",
  ];
  for (const sel of tries) {
    if (await safeClick(page, sel)) {
      await sleep(300);
      if (await page.$(".dropdown-list")) return true;
    }
  }
  await clickByTextVisible(page, "button,div,span,input", ["Choose a country","Country","Select country"]);
  await sleep(300);
  return !!(await page.$(".dropdown-list"));
}

async function pickCountry(page, countryName) {
  // 1) search polje (ako postoji)
  const searchSel = ".dropdown-list input[type='search'], .dropdown-list input[role='combobox'], .dropdown-list input[aria-autocomplete='list']";
  const search = await page.$(searchSel);
  if (search) {
    await search.click({ clickCount: 3 }).catch(() => {});
    await search.type(countryName, { delay: 35 });
    await page.keyboard.press("Enter");
    return true;
  }
  // 2) flag (.vti__flag.rs)
  const flag = await page.$(".dropdown-list li.dropdown-item .vti__flag.rs");
  if (flag) { await flag.click(); return true; }

  // 3) skrol + klik po tekstu
  const names = [countryName, "Serbia (Србија)"];
  const clicked = await page.evaluate((names) => {
    const list = document.querySelector(".dropdown-list") || document.body;
    function visible(el){ return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); }
    for (let pass = 0; pass < 60; pass++) {
      const items = Array.from(list.querySelectorAll("li.dropdown-item, li, div.dropdown-item")).filter(visible);
      const target = items.find(it => {
        const txt = (it.textContent || "").trim().toLowerCase();
        return names.some(n => txt.includes(n.toLowerCase()));
      });
      if (target) { target.click(); return true; }
      list.scrollBy(0, 260);
    }
    return false;
  }, names);
  return clicked;
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

// ---------- ROUTE ----------
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, country = "Serbia" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok:false, error:"Missing fields" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // 1) demo forma
    await page.goto("https://www.avatrade.com/demo-account", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(1000);

    // 2) cookies/subscribe close
    try { await clickByTextVisible(page, "button,a", ["Accept","Accept All","I agree","Got it","Not Now","Close"]); } catch {}

    // 3) polja
    await page.waitForSelector("#input-email", { timeout: 30000 });
    await page.waitForSelector("#input-password", { timeout: 30000 });
    await page.click("#input-email", { clickCount: 3 }); await page.type("#input-email", email, { delay: 30 });
    await page.click("#input-password", { clickCount: 3 }); await page.type("#input-password", password, { delay: 30 });

    // 4) country
    const opened = await openCountryDropdown(page);
    if (!opened) throw new Error("Country dropdown not opened");
    const picked = await pickCountry(page, country);
    if (!picked) throw new Error(`Country '${country}' not selected`);
    await sleep(400);

    // 5) submit – fallbackovi umesto pukog čekanja
    await page.waitForSelector("button[type='submit']", { timeout: 30000 });

    // trigger validacija (blur/input)
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
    await sleep(600);

    // ako je disabled, probaj uklanjanje atributa (nekad ostane zapelo)
    const disabledBefore = await page.$eval("button[type='submit']", b => !!b.disabled).catch(() => true);
    if (disabledBefore) {
      await page.evaluate(() => { const b = document.querySelector("button[type='submit']"); if (b) b.removeAttribute("disabled"); });
      await sleep(200);
    }

    // klik
    const clicked = await safeClick(page, "button[type='submit']");
    if (!clicked) await page.evaluate(() => { const b = document.querySelector("button[type='submit']"); if (b) b.click(); });

    // čekaj reakciju (navigation ili promenu DOM-a), ali nemoj pucati ako je sporije
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
      sleep(8000)
    ]);

    // 6) info
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
    console.error("create-demo error:", e?.message || e);
    return res.status(500).json({ ok:false, error: String(e) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));
app.listen(PORT, () => console.log("Listening on", PORT));