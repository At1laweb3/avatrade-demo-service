// index.js — AvaTrade demo + MT4 (robust) + screenshots served via /shots
// DEBUG_SCREENSHOTS=1 -> čuva PNG i u logu ispisuje "SNAP: <ime>"

import express from "express";
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());

const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET || "superSecret123";
const PORT = process.env.PORT || 3000;
// podrazumevano UKLJUČENO (možeš da ugasiš sa DEBUG_SCREENSHOTS=0)
const DEBUG = (process.env.DEBUG_SCREENSHOTS ?? "1") === "1";

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
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,site-per-process,IsolateOrigins"
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

// ===== helpers (country/phone)
async function openCountryDropdown(page){
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
  await page.evaluate(()=>{
    const hits = ["choose a country","country","select country"];
    const els = Array.from(document.querySelectorAll("button,div,span,input"));
    const el = els.find(e=>{
      const t=((e.textContent||e.placeholder||"")+"").toLowerCase();
      const vis=!!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return vis && hits.some(h=>t.includes(h));
    });
    if(el) el.click();
  });
  await sleep(400);
  return !!(await page.$(".dropdown-list"));
}
async function pickCountry(page, countryName){
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
  const names=[countryName,"Serbia (Србија)"];
  const ok = await page.evaluate((names)=>{
    const list = document.querySelector(".dropdown-list") || document.body;
    function vis(el){ return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); }
    for(let p=0;p<80;p++){
      const items = Array.from(list.querySelectorAll("li.dropdown-item, li, div.dropdown-item")).filter(vis);
      const target = items.find(it=>{
        const txt=(it.textContent||"").trim().toLowerCase();
        return names.some(n=>txt.includes(n.toLowerCase()));
      });
      if(target){ target.click(); return true; }
      list.scrollBy(0,260);
    }
    return false;
  }, names);
  return !!ok;
}
function normalizePhone(raw, defaultCc="+381"){
  if(!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g,"");
  if(s.startsWith("+")) return s;
  if(s.startsWith("00")) return "+"+s.slice(2);
  if(s.startsWith("0"))  return defaultCc + s.slice(1);
  return "+"+s;
}
function splitIntl(phone){
  const m = String(phone).match(/^\+(\d{1,4})(.*)$/);
  if(!m) return { cc:null, rest: phone.replace(/^\+/, "") };
  return { cc: `+${m[1]}`, rest: m[2].trim().replace(/\s+/g,"") };
}
async function setPhoneDialCountry(page, countryName){
  const openTries = [".iti__flag-container",".vti__dropdown",".vti__selection",".phone-wrapper .dropdown",".phone-wrapper"];
  for(const sel of openTries){
    if(await page.$(sel)){ await clickJS(page, sel); await sleep(300); break; }
  }
  const picked = await page.evaluate((name)=>{
    const lists = [
      document.querySelector(".iti__country-list"),
      document.querySelector(".vti__dropdown-list"),
      document.querySelector(".dropdown-menu"),
      document.querySelector(".dropdown-list")
    ].filter(Boolean);
    for(const list of lists){
      const items = Array.from(list.querySelectorAll("li,div")).filter(el=>/serbia|србија/i.test(el.textContent||""));
      if(items[0]){ items[0].dispatchEvent(new MouseEvent("click",{bubbles:true})); return true; }
      const byDial = Array.from(list.querySelectorAll("li,div")).find(el=>/\+381/.test(el.textContent||""));
      if(byDial){ byDial.dispatchEvent(new MouseEvent("click",{bubbles:true})); return true; }
    }
    return false;
  }, countryName || "Serbia");
  return picked;
}
async function typePhoneWithKeyboard(page, localDigits){
  const sels = ["input[type='tel']","input[placeholder*='phone' i]","input[name*='phone' i]","#input-phone"];
  for(const sel of sels){
    if(await page.$(sel)){
      await page.click(sel, { clickCount: 3 });
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.type(sel, localDigits, { delay: 30 });
      await page.keyboard.press("Tab");
      return true;
    }
  }
  return false;
}

// ==== extract/outcome ====
async function extractPageInfo(page){
  const text = await page.evaluate(()=>document.body?document.body.innerText:"");
  const excerpt = (text||"").replace(/\s+/g," ").slice(0,2000);
  const out = { found:false, login:null, server:null, password:null, excerpt };
  if(!text) return out;
  const login  = text.match(/(?:MT[45]\s*login|Your .* login credentials.*?Login|Login)\s*[:\-]?\s*(\d{6,12})/i);
  const server = text.match(/Server\s*[:\-]?\s*([A-Za-z0-9._\-\s]+?(?:Demo|Live)?)/i);
  const pass   = text.match(/Password\s*[:\-]?\s*([^\s\r\n]+)/i);
  if(login)  out.login  = login[1];
  if(server) out.server = server[1].trim();
  if(pass)   out.password = pass[1];
  if(out.login && out.server) out.found = true;
  return out;
}

async function waitForOutcome(page, maxMs=70000){
  const start=Date.now();
  const SUCCESS=[/congratulations/i,/account application has been approved/i,/webtrader login details/i,/trade on demo/i,/login details and platforms/i,/Your Demo Account is Being Created/i,/You will be transferred/i,/Thank you for your registration/i];
  const ERROR=[/error/i,/incorrect/i,/already used/i,/already exists/i,/try again/i,/protection/i,/blocked/i,/robot/i,/captcha/i,/not valid/i,/invalid/i,/failed/i,/sorry/i, /☹/];
  let last="";
  while(Date.now()-start<maxMs){
    const t = await page.evaluate(()=>document.body?document.body.innerText:"");
    last = t||"";
    if(SUCCESS.some(r=>r.test(last))) return {status:"success", text:last.slice(0,2000)};
    if(ERROR.some(r=>r.test(last)))   return {status:"error",   text:last.slice(0,2000)};
    await sleep(1200);
  }
  return {status:"timeout", text:last.slice(0,2000)};
}

// smartGoto demo
async function smartGotoDemo(page, shots){
  const urls = [
    "https://www.avatrade.com/demo-account",
    "https://www.avatrade.com/trading-account/demo-trading-account",
  ];
  for(const u of urls){
    log("PHASE: goto ->", u);
    await page.goto(u, { waitUntil:"domcontentloaded", timeout:90000 });
    await dismissBanners(page);
    await snap(page, "01_goto", shots, true);
    const emailCandidates=["#input-email","input[type='email']","input[name*='mail' i]","input[placeholder*='mail' i]"];
    const passCandidates =["#input-password","input[type='password']","input[name*='pass' i]","input[placeholder*='password' i]"];
    try{
      const emailSel = await waitForAny(page, emailCandidates, 8000);
      const passSel  = await waitForAny(page, passCandidates, 8000);
      return { emailSel, passSel };
    }catch{ /* try next */ }
  }
  throw new Error("Demo form not found on known URLs");
}

// ===== /create-demo =====
app.post("/create-demo", async (req, res) => {
  if (req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ ok:false, error:"Unauthorized" });

  const { name, email, password, phone, country="Serbia" } = req.body || {};
  if(!name || !email || !password || !phone){
    return res.status(400).json({ ok:false, error:"Missing fields (name, email, password, phone required)" });
  }

  const defaultCc = country.toLowerCase().includes("serb")?"+381":"+387";
  const normPhone = normalizePhone(phone, defaultCc);
  const { rest } = splitIntl(normPhone);

  let browser, phase="init"; const shots=[];
  try{
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(90000);
    await page.setDefaultNavigationTimeout(90000);

    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url(); const t=req.resourceType();
      if (t==="media" || /doubleclick|facebook|hotjar|segment|optimizely|fullstory|clarity|taboola|criteo/i.test(u)) req.abort();
      else req.continue();
    });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase="goto";
    const { emailSel, passSel } = await smartGotoDemo(page, shots);

    phase="fill";
    await typeJS(page, emailSel, email);
    await typeJS(page, passSel, password);
    await setPhoneDialCountry(page, country);
    await typePhoneWithKeyboard(page, rest);
    await snap(page,"02_filled",shots);

    phase="country";
    if(await openCountryDropdown(page)) await pickCountry(page, country);
    await snap(page,"03_country",shots);

    phase="submit";
    await page.evaluate((eSel,pSel)=>{
      const e=document.querySelector(eSel);
      const p=document.querySelector(pSel);
      for(const el of [e,p]){
        if(!el) continue;
        el.dispatchEvent(new Event("input",{bubbles:true}));
        el.dispatchEvent(new Event("change",{bubbles:true}));
        el.blur();
      }
      const b=document.querySelector("button[type='submit']") ||
        Array.from(document.querySelectorAll("button")).find(b=>/submit|sign up|start/i.test(b.textContent||""));
      if(b) b.removeAttribute("disabled");
    }, emailSel, passSel);

    await dismissBanners(page);
    await sleep(400);

    await clickJS(page, "button[type='submit']") || await clickJS(page, "button");
    await Promise.race([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:20000 }).catch(()=>{}),
      sleep(8000)
    ]);
    await snap(page,"04_after_submit",shots,true);

    const nowText = await page.evaluate(()=>document.body?.innerText || "");
    const looksLikeCreating = /Your Demo Account is Being Created|You will be transferred/i.test(nowText);
    if (looksLikeCreating) await snap(page,"04b_being_created",shots,true);

    phase="outcome";
    const outcome = await waitForOutcome(page, 65000);
    await snap(page, `05_outcome_${outcome.status}`, shots);

    phase="extract";
    const mt = await extractPageInfo(page);

    // heuristika "likely_created" – ako je "Being Created" ili smo na /crm/accounts
    const urlNow = page.url();
    const likely_created = looksLikeCreating || /\/crm\/accounts/.test(urlNow) ||
      /Thank you for your registration/i.test(outcome.text||"");

    const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok: outcome.status === "success",
      likely_created,
      note: `Outcome: ${outcome.status}${likely_created ? " (likely_created)" : ""}`,
      url: urlNow,
      outcome_excerpt: outcome.text?.slice(0,500) || "",
      mt_login: mt.login,
      mt_server: mt.server,
      mt_password: mt.password || password,
      page_excerpt: mt.excerpt,
      screenshots: screenshot_urls
    });

  }catch(e){
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase });
  }finally{
    try{ await browser?.close(); }catch{}
  }
});

// ===== helpers za MT4 (iframe)
async function getMyAccountFrame(page){
  const handle = await page.waitForSelector('#my_account, iframe[src*="avacrm"]', { timeout: 90000 });
  const frame = await handle.contentFrame();
  if(!frame) throw new Error("iframe content not available");
  return frame;
}
async function clickByText(frame, tagList, regex, hoverOnly=false){
  return await frame.evaluate((tags, pattern, hover)=>{
    const rx = new RegExp(pattern, "i");
    const els = Array.from(document.querySelectorAll(tags.join(",")));
    const el = els.find(e=>{
      const t=(e.textContent||"").trim();
      const vis = !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return vis && rx.test(t);
    });
    if(!el) return false;
    el.scrollIntoView({block:"center"});
    if(hover){
      el.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));
      el.dispatchEvent(new MouseEvent("mouseenter",{bubbles:true}));
      return true;
    }else{
      ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(t=>el.dispatchEvent(new MouseEvent(t,{bubbles:true})));
      return true;
    }
  }, tagList, regex.source, hoverOnly);
}
async function selectOptionByText(frame, optionText){
  const okSelect = await frame.evaluate((wanted)=>{
    const sels = Array.from(document.querySelectorAll("select"));
    for(const s of sels){
      const opt = Array.from(s.options).find(o=>o.textContent.trim().toLowerCase().includes(wanted.toLowerCase()));
      if(opt){ s.value = opt.value; s.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    }
    return false;
  }, optionText);
  if(okSelect) return true;

  await frame.evaluate(()=>{
    const toggles = Array.from(document.querySelectorAll("[role='combobox'], .Select-control, .dropdown, .select, .v-select, .css-1hwfws3, .css-1wa3eu0-placeholder"));
    const t = toggles.find(x=>!!(x.offsetParent || (x.getClientRects && x.getClientRects().length)));
    if(t){
      t.scrollIntoView({block:"center"});
      ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(ev=>t.dispatchEvent(new MouseEvent(ev,{bubbles:true})));
    }
  });
  await sleep(400);
  const picked = await clickByText(frame, ["li","div","span","button","a"], new RegExp(optionText,"i"));
  return !!picked;
}

// page-level click by text (za SSO)
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

// robust SSO login
async function ensureLoggedIn(page, email, password, shots){
  const ifr = await page.$('#my_account, iframe[src*="avacrm"]');
  if (ifr) return true;

  const emailSels = [
    "input[type='email']","input[name='email']","#email","input#formBasicEmail",
    "input[name='Email']","input[placeholder*='email' i]","input[name='username']"
  ];
  const passSels  = [
    "input[type='password']","input[name='password']","#password",
    "input#formBasicPassword","input[placeholder*='password' i]"
  ];

  async function tryFillHere() {
    try{
      const eSel = await waitForAny(page, emailSels, 7000);
      const pSel = await waitForAny(page, passSels, 7000);
      await typeJS(page, eSel, email);
      await typeJS(page, pSel, password);
      await snap(page, "mt4_login_filled_here", shots);
      await pageClickByText(page, ["button","a","div","span","input[type='submit']"], /(log ?in|sign ?in|continue|submit)/i);
      await Promise.race([
        page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:20000 }).catch(()=>{}),
        sleep(8000),
      ]);
      return true;
    }catch{ return false; }
  }

  await pageClickByText(page, ["button","a","div","span"], /(continue.*email|sign in.*email|use email)/i);
  await sleep(500);
  if (await tryFillHere()) return true;

  const loginUrls = [
    "https://accounts.avatrade.com/login",
    "https://webtrader7.avatrade.com/login",
    "https://www.avatrade.com/login",
    "https://my.avatrade.com/login"
  ];
  for(const u of loginUrls){
    try{
      log("LOGIN: goto", u);
      await page.goto(u, { waitUntil:"domcontentloaded", timeout:60000 });
      await dismissBanners(page);
      await snap(page, "mt4_login_page", shots, true);
      await pageClickByText(page, ["button","a","div","span"], /(continue.*email|sign in|log in)/i);
      await sleep(500);
      if (await tryFillHere()) break;
    }catch{}
  }

  await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil:"domcontentloaded", timeout:90000 });
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

    await page.setDefaultTimeout(90000);
    await page.setDefaultNavigationTimeout(90000);

    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url(); const t = req.resourceType();
      if (t==="media" || /doubleclick|facebook|hotjar|segment|optimizely|fullstory|clarity|taboola|criteo/i.test(u)) req.abort();
      else req.continue();
    });
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase="goto-accounts";
    await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil:"domcontentloaded", timeout:90000 });
    await dismissBanners(page);
    await snap(page,"mt4_01_accounts",shots,true);

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

// health
app.get("/", (_req,res)=>res.send("AvaTrade Demo Service live"));

// static shots
app.use("/shots", (req,res)=>{
  const filename = req.path.replace(/^\/+/, "");
  if(!/\.png$/i.test(filename)) return res.status(400).send("bad file");
  const full = path.join(process.cwd(), filename);
  if(!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

app.listen(PORT, ()=>console.log("Listening on", PORT));