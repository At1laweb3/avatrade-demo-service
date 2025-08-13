// index.js — AvaTrade demo signup (debug phases + JS-only clicks + signup sniff + portal login probe)

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
  const searchSel = ".dropdown-list input[type='search'], .dropdown-list input[role='combobox'], .dropdown-list input[aria-autocomplete='list']";
  if (await page.$(searchSel)) {
    await typeJS(page, searchSel, countryName);
    await page.keyboard.press("Enter");
    return true;
  }
  if (await page.$(".dropdown-list li.dropdown-item .vti__flag.rs")) {
    await clickJS(page, ".dropdown-list li.dropdown-item .vti__flag.rs");
    return true;
  }
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

// Pokušaj portala: klikni "Login" tab pored "Sign Up", popuni i probaj, vrati poruku
async function tryPortalLogin(page, email, password) {
  try {
    // Ako je na istoj komponenti: klik na "Login" tab
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll("a,button,div"));
      const loginTab = tabs.find(el => /login/i.test((el.textContent || "").trim()));
      if (loginTab) loginTab.click();
    });
    await sleep(600);

    // Polja u login tabu (često ista ID/placeholder imena)
    const emailOk = await typeJS(page, "input[type='email'], #input-email, input[placeholder*='mail' i]", email);
    const passOk  = await typeJS(page, "input[type='password'], #input-password, input[placeholder*='password' i]", password);

    if (!emailOk || !passOk) {
      // probaj da odeš na /login stranu, ako postoji
      await page.goto("https://www.avatrade.com/login", { waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});
      await typeJS(page, "input[type='email'], #input-email, input[placeholder*='mail' i]", email);
      await typeJS(page, "input[type='password'], #input-password, input[placeholder*='password' i]", password);
    }

    await clickJS(page, "button[type='submit'], button:has(>span:contains('Login'))");
    await Promise.race([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => {}),
      sleep(4000)
    ]);

    // Ako je ostao na formi, pokušaj da pročitaš grešku
    const err = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll(".error, .form-error, .alert, .validation, [role='alert'], .ng-invalid, .text-danger"));
      for (const el of cands) {
        const t = (el.textContent || "").trim();
        if (t && t.length > 3) return t.slice(0, 300);
      }
      // fallback: traži ključne reči u telu
      const body = (document.body.innerText || "").toLowerCase();
      if (body.includes("incorrect") || body.includes("invalid") || body.includes("activate")) {
        return (document.body.innerText || "").slice(0, 300);
      }
      return null;
    });

    return { success: !err, error_text: err || null, url: page.url() };
  } catch (e) {
    return { success: false, error_text: String(e), url: page.url() };
  }
}

// ---------- route ----------
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, country = "Serbia" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok:false, error:"Missing fields" });

  let browser, phase = "init";
  // signup sniff
  let signupStatus = null, signupMsg = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(45000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // prisluškuj XHR/Fetch – uhvati odgovor signup-a
    page.on("response", async (resp) => {
      try {
        const url = resp.url();
        if (/signup|register|submit|lead/i.test(url)) {
          const status = resp.status();
          let body = "";
          try { body = await resp.text(); } catch {}
          signupStatus = status;
          signupMsg = (body || "").slice(0, 400);
        }
      } catch {}
    });

    phase = "goto"; log("PHASE:", phase);
    await page.goto("https://www.avatrade.com/demo-account", { waitUntil: "networkidle2", timeout: 60000 });
    await sleep(800);

    phase = "cookies"; log("PHASE:", phase);
    await page.evaluate(() => {
      const texts = ["accept","accept all","i agree","got it","not now","close"];
      const els = Array.from(document.querySelectorAll("button,a"));
      const el = els.find(e => {
        const t = (e.textContent || "").toLowerCase();
        return texts.some(x => t.includes(x));
      });
      if (el) el.click();
    });

    phase = "fill"; log("PHASE:", phase);
    await page.waitForSelector("#input-email");
    await page.waitForSelector("#input-password");
    await typeJS(page, "#input-email", email);
    await typeJS(page, "#input-password", password);

    phase = "country-open"; log("PHASE:", phase);
    const opened = await openCountryDropdown(page);
    if (!opened) throw new Error("Country dropdown not opened");

    phase = "country-pick"; log("PHASE:", phase);
    const picked = await pickCountry(page, country);
    if (!picked) throw new Error(`Country '${country}' not selected`);
    await sleep(300);

    phase = "submit"; log("PHASE:", phase);
    // trigger validation
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

    phase = "extract"; log("PHASE:", phase);
    const mt = await extractPageInfo(page);
    let portalLogin = await tryPortalLogin(page, email, password);

    try { await page.screenshot({ path: "after_submit.png", fullPage: true }); } catch {}

    return res.json({
      ok: true,
      note: "Submit executed",
      url: page.url(),
      signup_status: signupStatus,
      signup_msg: signupMsg,
      mt_login: mt.login,
      mt_server: mt.server,
      mt_password: mt.password || password,
      portal_login_attempt: portalLogin,
      page_excerpt: mt.excerpt,
    });

  } catch (e) {
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error: String(e), phase, signup_status: signupStatus, signup_msg: signupMsg });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));
app.listen(PORT, () => console.log("Listening on", PORT));