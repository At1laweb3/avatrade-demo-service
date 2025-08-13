// index.js — AvaTrade flow: 1) demo-signup (sa telefonom) 2) CRM MT4 demo nalog
// DEBUG_SCREENSHOTS=1 => čuva PNG-ove i izbacuje javne URL-ove na /shots/<file>.png

import express from "express";
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());

const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET || "superSecret123";
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG_SCREENSHOTS === "1";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function checkAuth(req, res, next) {
  if (req.headers["x-auth"] !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

// ---------- LAUNCH ----------
async function launchBrowser() {
  return await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote",
      "--window-size=1280,1000",
      "--renderer-process-limit=1",
      "--js-flags=--max-old-space-size=256",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,site-per-process,IsolateOrigins",
    ],
    defaultViewport: { width: 1280, height: 1000 },
  });
}

function ts(){ return new Date().toISOString().replace(/[:.]/g,"-").slice(0,19); }

// screenshot (viewport; full=true po potrebi)
async function snap(page, label, shots, full=false) {
  if (!DEBUG) return;
  const name = `${ts()}_${label}.png`;
  try { await page.screenshot({ path: name, fullPage: !!full }); shots.push(name); } catch {}
}

async function clickJS(page, selector) {
  const ok = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    const evts = ["pointerdown","mousedown","click","pointerup","mouseup"];
    for (const t of evts) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    return true;
  }, selector);
  return !!ok;
}

async function typeJS(page, selector, value) {
  return await page.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.focus(); el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true }));
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, selector, value);
}

async function dismissBanners(page) {
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button,a,div[role='button']"));
    const el = btns.find(b => /accept|got it|agree|close|ok|not now/i.test((b.textContent||"")));
    if (el) el.click();
  });
}

// ----- Country dropdown (signup) -----
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
  if (await page.$(".dropdown-list li.dropdown-item .vti__flag.rs")) {
    await clickJS(page, ".dropdown-list li.dropdown-item .vti__flag.rs");
    return true;
  }
  const names = [countryName, "Serbia (Србија)"];
  const ok = await page.evaluate((names) => {
    const list = document.querySelector(".dropdown-list") || document.body;
    function vis(el){ return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); }
    for (let p=0;p<80;p++) {
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

// ----- phone helpers (signup) -----
function normalizePhone(raw, defaultCc = "+381") {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g,"");
  if (s.startsWith("+")) return s;
  if (s.startsWith("00")) return "+" + s.slice(2);
  if (s.startsWith("0"))  return defaultCc + s.slice(1);
  return "+" + s;
}
function splitIntl(phone) {
  const m = String(phone).match(/^\+(\d{1,4})(.*)$/);
  if (!m) return { cc: null, rest: phone.replace(/^\+/, "") };
  return { cc: `+${m[1]}`, rest: m[2].trim().replace(/\s+/g,"") };
}
async function setPhoneDialCountry(page, countryName) {
  const openTries = [".iti__flag-container", ".vti__dropdown", ".vti__selection", ".phone-wrapper .dropdown", ".phone-wrapper"];
  for (const sel of openTries) {
    if (await page.$(sel)) { await clickJS(page, sel); await sleep(300); break; }
  }
  const picked = await page.evaluate((name) => {
    const lists = [
      document.querySelector(".iti__country-list"),
      document.querySelector(".vti__dropdown-list"),
      document.querySelector(".dropdown-menu"),
      document.querySelector(".dropdown-list")
    ].filter(Boolean);
    for (const list of lists) {
      const items = Array.from(list.querySelectorAll("li,div")).filter(el => /serbia|србија/i.test(el.textContent||""));
      if (items[0]) { items[0].dispatchEvent(new MouseEvent("click",{bubbles:true})); return true; }
      const byDial = Array.from(list.querySelectorAll("li,div")).find(el => /\+381/.test(el.textContent||""));
      if (byDial) { byDial.dispatchEvent(new MouseEvent("click",{bubbles:true})); return true; }
    }
    return false;
  }, countryName || "Serbia");
  return picked;
}
async function typePhoneWithKeyboard(page, localDigits) {
  const sels = ["input[type='tel']","input[placeholder*='phone' i]","input[name*='phone' i]","#input-phone"];
  for (const sel of sels) {
    if (await page.$(sel)) {
      await page.click(sel, { clickCount: 3 });
      const isMac = await page.evaluate(() => navigator.platform.includes("Mac"));
      if (isMac) { await page.keyboard.down("Meta"); } else { await page.keyboard.down("Control"); }
      await page.keyboard.press("KeyA");
      if (isMac) { await page.keyboard.up("Meta"); } else { await page.keyboard.up("Control"); }
      await page.keyboard.press("Backspace");
      await page.type(sel, localDigits, { delay: 30 });
      await page.keyboard.press("Tab");
      return true;
    }
  }
  return false;
}

// ----- outcome extraction -----
async function extractPageInfo(page) {
  const text = await page.evaluate(() => document.body ? document.body.innerText : "");
  const excerpt = (text||"").replace(/\s+/g, " ").slice(0,2000);
  const out = { found:false, login:null, server:null, password:null, excerpt };
  if (!text) return out;
  const login  = text.match(/(?:MT[45]\s*login|Login)\s*[:\-]?\s*(\d{6,12})/i);
  const server = text.match(/Server\s*[:\-]?\s*([A-Za-z0-9._\-\s]+?(?:Demo|Live)?)/i);
  const pass   = text.match(/Password\s*[:\-]?\s*([^\s\r\n]+)/i);
  if (login)  out.login  = login[1];
  if (server) out.server = server[1].trim();
  if (pass)   out.password = pass[1];
  if (out.login && out.server) out.found = true;
  return out;
}

async function waitForOutcome(page, maxMs=60000) {
  const start = Date.now();
  const SUCCESS=[/congratulations/i,/account application has been approved/i,/webtrader login details/i,/trade on demo/i,/login details and platforms/i];
  const ERROR=[/error/i,/incorrect/i,/already used/i,/already exists/i,/try again/i,/protection/i,/blocked/i,/robot/i,/captcha/i,/not valid/i,/invalid/i];
  let last="";
  while (Date.now()-start<maxMs) {
    const t = await page.evaluate(() => document.body ? document.body.innerText : "");
    last = t||"";
    if (SUCCESS.some(r=>r.test(last))) return {status:"success", text:last.slice(0,2000)};
    if (ERROR.some(r=>r.test(last)))   return {status:"error",   text:last.slice(0,2000)};
    await sleep(1500);
  }
  return {status:"timeout", text:last.slice(0,2000)};
}

// ========== 1) /create-demo (signup forma sa telefonom) ==========
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, phone, country="Serbia" } = req.body || {};
  if (!name || !email || !password || !phone) {
    return res.status(400).json({ ok:false, error:"Missing fields (name, email, password, phone required)" });
  }
  const normPhone = normalizePhone(phone, country.toLowerCase().includes("serb")?"+381":"+387");
  const { rest } = splitIntl(normPhone);

  let browser, phase="init";
  const shots=[];
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", req => {
      const u=req.url(), t=req.resourceType();
      if (t==="media"||t==="font"||t==="manifest"||/googletagmanager|google-analytics|doubleclick|facebook|hotjar|segment|optimizely/i.test(u)) req.abort();
      else req.continue();
    });

    await page.setDefaultTimeout(45000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase="goto"; log("PHASE:", phase);
    await page.goto("https://www.avatrade.com/demo-account", { waitUntil:"domcontentloaded", timeout:60000 });
    await snap(page,"01_goto",shots,true);
    await dismissBanners(page);
    await sleep(400);

    phase="fill"; log("PHASE:", phase);
    await page.waitForSelector("#input-email");
    await page.waitForSelector("#input-password");
    await typeJS(page, "#input-email", email);
    await typeJS(page, "#input-password", password);

    await setPhoneDialCountry(page, country);
    await typePhoneWithKeyboard(page, rest);
    await snap(page,"02_filled",shots);

    phase="country"; log("PHASE:", phase);
    if (await openCountryDropdown(page)) await pickCountry(page, country);
    await snap(page,"03_country",shots);

    phase="submit"; log("PHASE:", phase);
    await page.evaluate(() => {
      const e=document.querySelector("#input-email");
      const p=document.querySelector("#input-password");
      for (const el of [e,p]) {
        if(!el) continue;
        el.dispatchEvent(new Event("input",{bubbles:true}));
        el.dispatchEvent(new Event("change",{bubbles:true}));
        el.blur();
      }
    });
    await dismissBanners(page);
    await sleep(400);
    await page.evaluate(()=>{ const b=document.querySelector("button[type='submit']"); if(b) b.removeAttribute("disabled"); });
    await clickJS(page, "button[type='submit']");
    await Promise.race([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:15000 }).catch(()=>{}),
      sleep(8000)
    ]);
    await snap(page,"04_after_submit",shots);

    phase="outcome"; log("PHASE:", phase);
    const outcome = await waitForOutcome(page, 60000);
    await snap(page, `05_outcome_${outcome.status}`, shots);

    phase="extract"; log("PHASE:", phase);
    const mt = await extractPageInfo(page);

    const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok: outcome.status === "success",
      note: `Outcome: ${outcome.status}`,
      url: page.url(),
      outcome_excerpt: outcome.text?.slice(0,500) || "",
      mt_login: mt.login,
      mt_server: mt.server,
      mt_password: mt.password || password,
      page_excerpt: mt.excerpt,
      phone_used: normPhone,
      screenshots: screenshot_urls
    });

  } catch (e) {
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

// ========== 2) /create-mt4 (posle logina u CRM doda Demo MT4/EUR) ==========
app.post("/create-mt4", checkAuth, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok:false, error:"Missing fields (email, password)" });

  let browser, phase="init";
  const shots=[];
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(45000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // otvori accounts; ako traži login – uloguj se
    phase="goto-accounts"; log("PHASE:", phase);
    await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil:"domcontentloaded", timeout:60000 });
    await snap(page,"mt4_01_accounts",shots);

    // ako je login forma:
    const hasLogin = await page.$("input[type='email'], input[name='email']");
    if (hasLogin) {
      phase="login"; log("PHASE:", phase);
      await typeJS(page, "input[type='email'], input[name='email']", email);
      await typeJS(page, "input[type='password'], input[name='password']", password);
      // button sa tekstom "Login" / "Sign in"
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll("button, a, div[role='button']"))
          .find(b => /login|sign in/i.test(b.textContent||""));
        if (btn) btn.click();
      });
      await Promise.race([
        page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:20000 }).catch(()=>{}),
        sleep(6000)
      ]);
      await snap(page,"mt4_02_after_login",shots);
    }

    await dismissBanners(page);
    await sleep(500);

    // klik na "+ Add an Account" -> "Demo Account"
    phase="add-account"; log("PHASE:", phase);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, a, div[role='button']"))
        .find(b => /\+\s*add an account/i.test(b.textContent||""));
      if (btn) btn.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    });
    await sleep(800);
    await page.evaluate(() => {
      const dd = Array.from(document.querySelectorAll("button, a, div"))
        .find(b => /demo account/i.test(b.textContent||""));
      if (dd) dd.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    });
    await Promise.race([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:15000 }).catch(()=>{}),
      sleep(6000)
    ]);
    await snap(page,"mt4_03_add_demo_form",shots);

    // izaberi "CFD - MT4" i "EUR"
    phase="choose-options"; log("PHASE:", phase);
    await page.evaluate(() => {
      // pokušaj kroz <select> (ako postoji)
      const selects = Array.from(document.querySelectorAll("select"));
      const pick = (sel, rx) => {
        if (!sel) return false;
        const opt = Array.from(sel.options||[]).find(o => rx.test(o.text));
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change",{bubbles:true})); return true; }
        return false;
      };
      const [sel1, sel2] = selects;
      let ok1 = pick(sel1, /CFD\s*-\s*MT4/i);
      let ok2 = pick(sel2||selects[1], /^EUR$/i);

      // ako nije select, pokušaj klik dropdown pa klik tekst
      function clickText(rex){
        const el = Array.from(document.querySelectorAll("li,div,span,a"))
          .find(e => rex.test((e.textContent||"").trim()));
        if (el) { el.dispatchEvent(new MouseEvent("click",{bubbles:true})); return true; }
        return false;
      }

      if (!ok1) {
        const firstDD = Array.from(document.querySelectorAll("div[role='combobox'], .dropdown, .select, .Select")).shift();
        if (firstDD) firstDD.dispatchEvent(new MouseEvent("click",{bubbles:true}));
        clickText(/CFD\s*-\s*MT4/i);
      }
      if (!ok2) {
        const dds = Array.from(document.querySelectorAll("div[role='combobox'], .dropdown, .select, .Select"));
        const secondDD = dds[1] || dds[dds.length-1];
        if (secondDD) secondDD.dispatchEvent(new MouseEvent("click",{bubbles:true}));
        clickText(/^EUR$/i);
      }
    });
    await snap(page,"mt4_04_options_set",shots);

    // Submit
    phase="submit"; log("PHASE:", phase);
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, a"))
        .find(b => /submit/i.test(b.textContent||""));
      if (btn) btn.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    });
    await Promise.race([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:25000 }).catch(()=>{}),
      sleep(10000)
    ]);
    await snap(page,"mt4_05_after_submit",shots,true);

    // čekaj rezultat
    phase="outcome"; log("PHASE:", phase);
    const out = await extractPageInfo(page); // očekujemo Login/Server na "Your Demo Account is Ready!"
    const ok = !!out.login;

    const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok,
      note: ok ? "MT4 created" : "Could not parse login/server",
      url: page.url(),
      mt4_login: out.login || null,
      mt4_server: out.server || null,
      screenshots: screenshot_urls
    });

  } catch (e) {
    console.error("create-mt4 error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

// health
app.get("/", (_req,res)=>res.send("AvaTrade Demo Service live"));

// serve screenshots
app.use("/shots", (req,res)=>{
  const filename = req.path.replace(/^\/+/, "");
  if (!/\.png$/i.test(filename)) return res.status(400).send("bad file");
  const full = path.join(process.cwd(), filename);
  if (!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

app.listen(PORT, ()=>console.log("Listening on", PORT));