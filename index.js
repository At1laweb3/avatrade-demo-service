// index.js — AvaTrade demo + MT4 (robust) + screenshots
// DEBUG_SCREENSHOTS=1 -> čuva PNG-ove i u logu ispisuje "SNAP: <ime>"

import express from "express";
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());

const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET || "superSecret123";
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG_SCREENSHOTS === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const log = (...a) => console.log(...a);

// ---------- LAUNCH ----------
async function launchBrowser() {
  return await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
      "--disable-gpu","--no-zygote","--window-size=1280,1000",
      "--renderer-process-limit=1","--js-flags=--max-old-space-size=256",
      "--no-first-run","--no-default-browser-check",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,site-per-process,IsolateOrigins",
    ],
    defaultViewport: { width: 1280, height: 1000 },
  });
}

async function snap(page, label, shots, full=false) {
  if (!DEBUG) return;
  const name = `${ts()}_${label}.png`;
  try { await page.screenshot({ path: name, fullPage: !!full }); shots.push(name); console.log("SNAP:", name); } catch {}
}

async function clickJS(ctx, selector) {
  const ok = await ctx.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    for (const t of ["pointerdown","mousedown","click","pointerup","mouseup"])
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    return true;
  }, selector);
  return !!ok;
}
async function typeJS(ctx, selector, value) {
  return await ctx.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.focus(); el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true }));
    el.value = val; el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, selector, value);
}
async function dismissBanners(page) {
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button,a,div[role='button']"));
    const el = btns.find(b => /accept|got it|agree|allow|close|not now|ok/i.test((b.textContent||"")));
    if (el) el.click();
    const x = document.querySelector("#solitics-popup-maker .solitics-close-button");
    if (x) x.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const pop = document.getElementById("solitics-popup-maker");
    if (pop) pop.style.display = "none";
  });
}
async function waitForAny(page, selectors, totalMs=60000) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el) {
        const vis = await page.evaluate(e => !!(e.offsetParent || (e.getClientRects && e.getClientRects().length)), el);
        if (vis) return sel;
      }
    }
    await sleep(400);
  }
  throw new Error("none of selectors appeared: " + selectors.join(" | "));
}

// ===== util: click by visible text on PAGE (not frame)
async function pageClickByText(page, tags, rx) {
  return await page.evaluate((tags, pattern) => {
    const re = new RegExp(pattern, "i");
    const els = Array.from(document.querySelectorAll(tags.join(",")));
    const el = els.find(e => {
      const t = (e.textContent || "").trim();
      const vis = !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return vis && re.test(t);
    });
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { bubbles: true }))
    );
    return true;
  }, tags, rx.source);
}

// ==== country/phone helpers (create-demo) ====
async function openCountryDropdown(page){ /* unchanged */ }
async function pickCountry(page, countryName){ /* unchanged */ }
function normalizePhone(raw, defaultCc="+381"){ /* unchanged */ }
function splitIntl(phone){ /* unchanged */ }
async function setPhoneDialCountry(page, countryName){ /* unchanged */ }
async function typePhoneWithKeyboard(page, localDigits){ /* unchanged */ }

// ==== MT extractors / outcome ====
async function extractPageInfo(page){ /* unchanged */ }
async function waitForOutcome(page, maxMs=60000){ /* unchanged, includes “Being Created” */ }

// smartGoto demo (unchanged)
async function smartGotoDemo(page, shots){ /* unchanged */ }

// ===== /create-demo (unchanged except "likely_created" flag is kept) =====
app.post("/create-demo", async (req, res) => { /* unchanged from poslednje verzije koju sam ti poslao */ });

// ===== helpers za MT4 =====
async function getMyAccountFrame(page){
  const handle = await page.waitForSelector('#my_account, iframe[src*="avacrm"]', { timeout: 90000 });
  const frame = await handle.contentFrame();
  if(!frame) throw new Error("iframe content not available");
  return frame;
}
async function clickByText(frame, tagList, regex, hoverOnly=false){ /* unchanged */ }
async function selectOptionByText(frame, optionText){ /* unchanged */ }

// NEW: robust login flow for SSO
async function ensureLoggedIn(page, email, password, shots) {
  // 1) ako već vidimo iframe, gotovi smo
  const ifr = await page.$('#my_account, iframe[src*="avacrm"]');
  if (ifr) return true;

  // 2) probaj da nađeš login inpute na trenutnoj stranici
  const emailSels = [
    "input[type='email']","input[name='email']","#email",
    "input#formBasicEmail","input[name='Email']",
    "input[placeholder*='email' i]","input[name='username']"
  ];
  const passSels  = [
    "input[type='password']","input[name='password']","#password",
    "input#formBasicPassword","input[placeholder*='password' i]"
  ];

  async function tryFillHere() {
    try {
      const eSel = await waitForAny(page, emailSels, 7000);
      const pSel = await waitForAny(page, passSels, 7000);
      await typeJS(page, eSel, email);
      await typeJS(page, pSel, password);
      await snap(page, "mt4_login_filled_here", shots);
      await pageClickByText(page, ["button","a","div","span","input[type='submit']"], /(log ?in|sign ?in|continue|submit)/i);
      await Promise.race([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(()=>{}),
        sleep(8000),
      ]);
      return true;
    } catch { return false; }
  }

  // 2a) nekad prvo treba klik “Continue with email”
  await pageClickByText(page, ["button","a","div","span"], /(continue.*email|sign in.*email|use email)/i);
  await sleep(500);
  if (await tryFillHere()) return true;

  // 3) probaj poznate login URL-ove pa opet fill
  const loginUrls = [
    "https://accounts.avatrade.com/login",
    "https://webtrader7.avatrade.com/login",
    "https://www.avatrade.com/login",
    "https://my.avatrade.com/login"
  ];
  for (const u of loginUrls) {
    try {
      log("LOGIN: goto", u);
      await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 });
      await dismissBanners(page);
      await snap(page, "mt4_login_page", shots, true);
      await pageClickByText(page, ["button","a","div","span"], /(continue.*email|sign in|log in)/i);
      await sleep(500);
      if (await tryFillHere()) break;
    } catch {}
  }

  // 4) vrati se na accounts i proveri iframe
  await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil: "domcontentloaded", timeout: 90000 });
  await dismissBanners(page);
  await snap(page, "mt4_accounts_after_login", shots, true);
  return !!(await page.$('#my_account, iframe[src*="avacrm"]'));
}

// ===== /create-mt4 =====
app.post("/create-mt4", async (req, res) => {
  if (req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ ok:false, error:"Unauthorized" });

  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok:false, error:"Missing email/password" });

  let browser; const shots=[]; let phase="init";
  try{
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url(); const t = req.resourceType();
      if (t==="media" || /doubleclick|facebook|hotjar|segment|optimizely|fullstory|clarity|taboola|criteo/i.test(u)) req.abort();
      else req.continue();
    });

    await page.setDefaultTimeout(90000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase="goto-accounts";
    await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil:"domcontentloaded", timeout:90000 });
    await dismissBanners(page);
    await snap(page, "mt4_01_accounts", shots, true);

    phase="maybe-login";
    if (!(await page.$('#my_account, iframe[src*="avacrm"]'))) {
      const okLogin = await ensureLoggedIn(page, email, password, shots);
      if (!okLogin) throw new Error("login flow failed (no iframe after attempts)");
    }

    phase="iframe";
    const frame = await getMyAccountFrame(page);
    await snap(page,"mt4_05_iframe_loaded",shots);

    phase="hover-add";
    const hovered = await clickByText(frame, ["button","a","div","span"], /\+\s*Add an Account/i, true);
    await snap(page,"mt4_06_hover_add",shots);
    if(!hovered) await clickByText(frame, ["button","a","div","span"], /\+\s*Add an Account/i, false);
    await sleep(500);

    phase="click-demo";
    await clickByText(frame, ["button","a","div","span"], /Demo Account/i, false);
    await snap(page,"mt4_07_click_demo",shots,true);

    phase="set-dropdowns";
    await frame.waitForSelector("body", { timeout: 90000 });
    await selectOptionByText(frame, "CFD - MT4");
    await selectOptionByText(frame, "EUR");
    await snap(page,"mt4_08_dropdowns_set",shots);

    phase="submit";
    await clickByText(frame, ["button","a"], /^Submit$/i, false);
    await sleep(2500);
    await snap(page,"mt4_09_after_submit",shots,true);

    phase="extract";
    const credText = await frame.evaluate(()=>document.body?.innerText || "");
    let login = (credText.match(/Login\s*:\s*(\d{6,12})/i)||[])[1] || null;
    if(!login){ const mt = await extractPageInfo(page); login = mt.login || null; }
    await snap(page,`mt4_10_result_${login? "ok":"miss"}`,shots,true);

    const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({ ok: !!login, mt4_login: login, screenshots: screenshot_urls });

  }catch(e){
    console.error("create-mt4 error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase, screenshots: [] });
  }finally{
    try{ await browser?.close(); }catch{}
  }
});

// Ping
app.get("/", (_req,res)=>res.send("AvaTrade Demo Service live"));

// Static shots
app.use("/shots", (req,res)=>{
  const filename = req.path.replace(/^\/+/, "");
  if(!/\.png$/i.test(filename)) return res.status(400).send("bad file");
  const full = path.join(process.cwd(), filename);
  if(!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

app.listen(PORT, ()=>console.log("Listening on", PORT));