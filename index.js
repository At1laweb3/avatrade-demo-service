// index.js — AvaTrade DEMO + MT4 (CF-bypass, CTA open, iframe-aware, safe-eval, screenshots in /shots)
// DEBUG_SCREENSHOTS=1 => snima PNG i u logu "SNAP: <ime>"

import express from "express";
import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";

const app = express();
app.use(express.json());

const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET || "superSecret123";
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG_SCREENSHOTS === "1";

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const log   = (...a)=>console.log(...a);
const ts    = ()=>new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);

// ---------- LAUNCH ----------
async function launchBrowser(){
  return await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
      "--disable-gpu","--no-zygote","--window-size=1280,1000",
      "--renderer-process-limit=1","--js-flags=--max-old-space-size=256",
      "--no-first-run","--no-default-browser-check",
      "--disable-features=Translate,BackForwardCache,AcceptCHFrame,site-per-process,IsolateOrigins",
      "--disable-blink-features=AutomationControlled",
    ],
    defaultViewport: { width:1280, height:1000 },
  });
}

// ---------- UTILS ----------
async function snap(page, label, shots, full=false){
  if(!DEBUG) return;
  const name = `${ts()}_${label}.png`;
  try{ await page.screenshot({ path:name, fullPage:!!full }); shots.push(name); console.log("SNAP:", name); }catch{}
}
async function safeEval(ctx, fn, args=[], tries=3){
  for(let i=0;i<tries;i++){
    try{ return await ctx.evaluate(fn, ...args); }
    catch(e){ if(!/Execution context was destroyed/i.test(String(e))) throw e; await sleep(600); }
  }
  return null;
}
async function clickJS(ctx, selector){
  const ok = await safeEval(ctx,(sel)=>{
    const el = document.querySelector(sel); if(!el) return false;
    el.scrollIntoView({block:"center", inline:"center"});
    for(const t of ["pointerdown","mousedown","click","pointerup","mouseup"])
      el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true}));
    return true;
  }, [selector]);
  return !!ok;
}
async function typeJS(ctx, selector, value){
  const ok = await safeEval(ctx,(sel,val)=>{
    const el = document.querySelector(sel); if(!el) return false;
    el.focus(); el.value=""; el.dispatchEvent(new Event("input",{bubbles:true}));
    el.value = val; el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  }, [selector,value]);
  return !!ok;
}
async function visibleSelector(ctx, selectors){
  for(const sel of selectors){
    const el = await ctx.$(sel);
    if(el){
      const vis = await safeEval(ctx, e=>!!(e.offsetParent || (e.getClientRects && e.getClientRects().length)), [el]);
      if(vis) return sel;
    }
  }
  return null;
}

async function dismissBanners(page){
  await safeEval(page,()=>{
    // cookies / accept
    const btn = Array.from(document.querySelectorAll("button,a,div[role='button']"))
      .find(b=>/accept|got it|agree|ok/i.test((b.textContent||"")));
    if(btn) btn.click();

    // solitics popup
    const x = document.querySelector("#solitics-popup-maker .solitics-close-button");
    if(x) x.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    const pop = document.getElementById("solitics-popup-maker");
    if(pop) pop.style.display="none";
  });
}

async function gotoWithCF(page, url, shots, prefix, maxTries=8){
  for(let i=1;i<=maxTries;i++){
    await page.goto(url, { waitUntil:"domcontentloaded", timeout:90000 });
    await dismissBanners(page);
    await snap(page, `${prefix}_nav_${i}`, shots);
    try{ await page.waitForNetworkIdle({idleTime:500, timeout:5000}); }catch{}

    const t = await safeEval(page,()=>document.body?.innerText || "");
    if(/unblock challenges\.cloudflare\.com/i.test(t)){ await sleep(2500); continue; }
    if(/Verifying you are human|needs to review the security/i.test(t)){ await sleep(3000); continue; }
    return true;
  }
  return false;
}

async function waitForAny(page, selectors, totalMs=60000){
  const start=Date.now();
  while(Date.now()-start<totalMs){
    for(const sel of selectors){
      const el = await page.$(sel);
      if(el){
        const vis = await safeEval(page, e=>!!(e.offsetParent || (e.getClientRects && e.getClientRects().length)), [el]);
        if(vis) return sel;
      }
    }
    await sleep(400);
  }
  throw new Error("none of selectors appeared: " + selectors.join(" | "));
}

// -------- DEMO helpers --------
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
  return { cc:`+${m[1]}`, rest:m[2].trim().replace(/\s+/g,"") };
}

async function maybeClickOpenDemoCTA(page){
  const clicked = await safeEval(page,()=>{
    const labels = /(try\s*free\s*demo|open\s*(a\s*)?demo|create\s*(your\s*)?free\s*demo|start\s*now|start\s*trading|get\s*your\s*free\s*demo)/i;
    const els = Array.from(document.querySelectorAll("a,button,div[role='button']"))
      .filter(e => !!(e.offsetParent || (e.getClientRects && e.getClientRects().length)));
    const cta = els.find(e => labels.test(e.textContent||""));
    if(cta){
      cta.scrollIntoView({block:"center"});
      ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(t=>cta.dispatchEvent(new MouseEvent(t,{bubbles:true})));
      return true;
    }
    return false;
  });
  if(clicked){ try{ await page.waitForNetworkIdle({idleTime:500, timeout:6000}); }catch{} }
  return !!clicked;
}

async function findDemoFormInPageOrFrames(page, timeoutMs=20000){
  const emailSels = ["#input-email","input[type='email']","input[name*='mail' i]","input[placeholder*='mail' i]"];
  const passSels  = ["#input-password","input[type='password']","input[name*='pass' i]","input[placeholder*='password' i]"];
  const start = Date.now();
  while(Date.now()-start<timeoutMs){
    // main
    let eSel = await visibleSelector(page, emailSels);
    let pSel = await visibleSelector(page, passSels);
    if(eSel && pSel) return { ctx: page, emailSel: eSel, passSel: pSel };

    // any frame
    for(const f of page.frames()){
      try{
        eSel = await visibleSelector(f, emailSels);
        pSel = await visibleSelector(f, passSels);
        if(eSel && pSel) return { ctx: f, emailSel: eSel, passSel: pSel };
      }catch{}
    }

    await sleep(400);
  }
  return null;
}

async function openCountryDropdown(page){
  const tries = [
    ".country-wrapper .vue-country-select .dropdown",
    ".country-wrapper .vue-country-select",
    "input[placeholder='Choose a country']",
    ".country-wrapper .selected-flag",
    ".country-wrapper"
  ];
  for(const sel of tries){ if(await clickJS(page, sel)){ await sleep(300); if(await page.$(".dropdown-list")) return true; } }
  return false;
}
async function pickCountry(page, countryName){
  const searchSel = ".dropdown-list input[type='search'], .dropdown-list input[role='combobox'], .dropdown-list input[aria-autocomplete='list']";
  if(await page.$(searchSel)){ await typeJS(page, searchSel, countryName); await page.keyboard.press("Enter"); return true; }
  const ok = await safeEval(page,(name)=>{
    const list = document.querySelector(".dropdown-list") || document.body;
    const items = Array.from(list.querySelectorAll("li,div")).filter(el=>!!(el.offsetParent || (el.getClientRects && el.getClientRects().length)));
    const t = items.find(it=> (it.textContent||"").toLowerCase().includes(name.toLowerCase()));
    if(t){ t.click(); return true; }
    return false;
  },[countryName]);
  return !!ok;
}
async function typePhoneWithKeyboard(page, localDigits){
  const sels = ["input[type='tel']","input[placeholder*='phone' i]","input[name*='phone' i]","#input-phone"];
  for(const sel of sels){
    if(await page.$(sel)){
      await page.click(sel,{clickCount:3});
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.type(sel, localDigits, {delay:30});
      await page.keyboard.press("Tab");
      return true;
    }
  }
  return false;
}

async function extractPageInfo(page){
  const text = await safeEval(page,()=>document.body?document.body.innerText:"") || "";
  const excerpt = text.replace(/\s+/g," ").slice(0,2000);
  const out = { found:false, login:null, server:null, password:null, excerpt };
  const login  = text.match(/(?:MT[45]\s*login|Your .* login credentials.*?Login|Login)\s*[:\-]?\s*(\d{6,12})/i);
  const server = text.match(/Server\s*[:\-]?\s*([A-Za-z0-9._\-\s]+?(?:Demo|Live)?)/i);
  const pass   = text.match(/Password\s*[:\-]?\s*([^\s\r\n]+)/i);
  if(login)  out.login  = login[1];
  if(server) out.server = server[1]?.trim();
  if(pass)   out.password = pass[1];
  if(out.login && out.server) out.found = true;
  return out;
}
async function waitForOutcome(page, maxMs=30000){
  const start = Date.now();
  const OK = [/Your Demo Account is Being Created/i,/congratulations/i,/account application has been approved/i,/webtrader login details/i,/trade on demo/i,/login details and platforms/i];
  const BAD= [/error/i,/incorrect/i,/already used|already exists/i,/try again/i,/protection|blocked|robot|captcha/i,/not valid|invalid/i];
  let last="";
  while(Date.now()-start<maxMs){
    const t = await safeEval(page,()=>document.body?.innerText || "") || "";
    last = t;
    if(OK.some(r=>r.test(last))) return {status:"success", text:last.slice(0,2000)};
    if(BAD.some(r=>r.test(last))) return {status:"error", text:last.slice(0,2000)};
    await sleep(1200);
  }
  return {status:"assumed", text:last.slice(0,2000)};
}

// -------- DEMO main --------
async function smartGotoDemo(page, shots){
  const urls = [
    "https://www.avatrade.com/demo-account",
    "https://www.avatrade.com/trading-account/demo-trading-account",
    "https://www.avatrade.com/demo-account#form",
  ];
  for(const u of urls){
    log("PHASE: goto ->", u);
    await gotoWithCF(page, u, shots, "demo_nav_cf");
    await dismissBanners(page);
    await snap(page, "01_goto", shots, true);

    // pokušaj da otvoriš formu preko CTA
    await maybeClickOpenDemoCTA(page).catch(()=>{});
    await dismissBanners(page);

    const ctx = await findDemoFormInPageOrFrames(page, 12000);
    if(ctx) return ctx;
  }
  throw new Error("Demo form selectors not found on known URLs");
}

app.post("/create-demo", async (req,res)=>{
  if (req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ ok:false, error:"Unauthorized" });
  const { name, email, password, phone, country="Serbia" } = req.body || {};
  if(!name || !email || !password || !phone) return res.status(400).json({ ok:false, error:"Missing fields (name,email,password,phone)" });

  const defaultCc = country.toLowerCase().includes("serb")?"+381":"+387";
  const normPhone = normalizePhone(phone, defaultCc);
  const { rest } = splitIntl(normPhone);

  let browser, phase="init"; const shots=[];
  try{
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", req=>{
      const u=req.url(); const t=req.resourceType();
      if(t==="media" || /doubleclick|facebook|hotjar|segment|optimizely|fullstory|clarity|taboola|criteo/i.test(u)) req.abort();
      else req.continue();
    });
    await page.setDefaultTimeout(90000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase="goto";
    const form = await smartGotoDemo(page, shots);

    phase="fill";
    await typeJS(form.ctx, form.emailSel, email);
    await typeJS(form.ctx, form.passSel,  password);
    await snap(page, "02_filled", shots);

    await dismissBanners(page);
    openCountryDropdown(page).catch(()=>{});
    pickCountry(page, country).catch(()=>{});
    typePhoneWithKeyboard(page, rest).catch(()=>{});

    phase="submit";
    await safeEval(form.ctx,(eSel,pSel)=>{
      const e=document.querySelector(eSel), p=document.querySelector(pSel);
      for(const el of [e,p]){ if(!el) continue; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); }
      const b=document.querySelector("button[type='submit']") ||
        Array.from(document.querySelectorAll("button")).find(x=>/submit|sign up|start/i.test(x.textContent||""));
      if(b) b.removeAttribute("disabled");
    }, [form.emailSel, form.passSel]);
    await clickJS(form.ctx, "button[type='submit']") || await clickJS(page, "button");
    await Promise.race([ page.waitForNavigation({waitUntil:"domcontentloaded", timeout:20000}).catch(()=>{}), sleep(8000) ]);
    try{ await page.waitForNetworkIdle({idleTime:500, timeout:3000}); }catch{}
    await snap(page, "04_after_submit", shots, true);

    phase="outcome";
    const outcome = await waitForOutcome(page, 30000);
    await snap(page, `05_outcome_${outcome.status}`, shots);

    const mt = await extractPageInfo(page);
    const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok: outcome.status==="success" || outcome.status==="assumed",
      note: `Outcome: ${outcome.status}`,
      url: page.url(),
      outcome_excerpt: outcome.text?.slice(0,500) || "",
      mt_login: mt.login,
      mt_server: mt.server,
      mt_password: mt.password || password,
      page_excerpt: mt.excerpt,
      screenshots: screenshot_urls
    });

  }catch(e){
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    // po želji forsiramo nastavak MT4 da ne blokira tok
    return res.status(200).json({ ok:true, note:`force-continue (${phase})`, screenshots:[] });
  }finally{
    try{ await browser?.close(); }catch{}
  }
});

// ---------- MT4 helpers ----------
async function closeModals(page){
  await safeEval(page,()=>{
    for(const sel of ["button[aria-label='Close']", ".modal-header .close", "button.close", "[data-dismiss='modal']"]){
      const b=document.querySelector(sel); if(b) b.click();
    }
    const dlg = document.querySelector("[role='dialog']"); if(dlg) dlg.style.display="none";
  });
}
async function waitSpinnerGone(page, ms=30000){
  const start=Date.now();
  while(Date.now()-start<ms){
    const has = await safeEval(page,()=>{
      const sel=[".spinner",".loading",".lds-ring",".lds-roller",".preloader",".MuiBackdrop-root",".ant-spin"];
      return sel.some(s=> document.querySelector(s));
    }) || false;
    if(!has) return true;
    await sleep(800);
  }
  return false;
}
async function ensureAccountsUI(page, shots){
  const iframe = await page.$('#my_account, iframe[src*="avacrm"]');
  if(iframe) return { mode:"iframe", handle: iframe };

  const hasAdd = await safeEval(page,()=>{
    const btn = Array.from(document.querySelectorAll("button,a,div[role='button']"))
      .find(b=>/\+\s*Add an Account|Add an Account/i.test(b.textContent||""));
    return !!btn;
  }) || false;
  if(hasAdd) return { mode:"spa", handle: null };

  await waitSpinnerGone(page, 15000);
  await snap(page,"mt4_iframe_retry_1",shots);
  const iframe2 = await page.$('#my_account, iframe[src*="avacrm"]');
  if(iframe2) return { mode:"iframe", handle: iframe2 };

  await snap(page,"mt4_iframe_retry_2",shots);
  const hasAdd2 = await safeEval(page,()=>{
    const btn = Array.from(document.querySelectorAll("button,a,div[role='button']"))
      .find(b=>/\+\s*Add an Account|Add an Account/i.test(b.textContent||""));
    return !!btn;
  }) || false;
  if(hasAdd2) return { mode:"spa", handle: null };

  await snap(page,"mt4_iframe_retry_3",shots);
  throw new Error("accounts UI not available");
}
async function getFrameFromHandle(handle){ try{ return await handle.contentFrame(); }catch{ return null; } }

async function clickByText(ctx, selectors, regex, hover=false){
  const res = await safeEval(ctx,(sels, pattern, hov)=>{
    const rx = new RegExp(pattern,"i");
    const els = Array.from(document.querySelectorAll(sels.join(",")));
    const el = els.find(e=>{
      const t=(e.textContent||"").trim();
      const vis=!!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return vis && rx.test(t);
    });
    if(!el) return false;
    el.scrollIntoView({block:"center"});
    if(hov){
      el.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));
      el.dispatchEvent(new MouseEvent("mouseenter",{bubbles:true}));
      return true;
    }else{
      ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(t=>el.dispatchEvent(new MouseEvent(t,{bubbles:true})));
      return true;
    }
  }, [selectors, regex.source, hover]);
  return !!res;
}
async function selectOptionGeneric(ctx, wanted){
  const okSelect = await safeEval(ctx,(txt)=>{
    const sels = Array.from(document.querySelectorAll("select"));
    for(const s of sels){
      const opt = Array.from(s.options).find(o=> (o.textContent||"").toLowerCase().includes(txt.toLowerCase()));
      if(opt){ s.value = opt.value; s.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    }
    return false;
  }, [wanted]);
  if(okSelect) return true;

  await safeEval(ctx,()=>{
    const toggles = Array.from(document.querySelectorAll("[role='combobox'], .Select-control, .dropdown, .select, .v-select, .css-1hwfws3, .css-1wa3eu0-placeholder, .ant-select-selector"));
    const t = toggles.find(x=> !!(x.offsetParent || (x.getClientRects && x.getClientRects().length)));
    if(t){
      t.scrollIntoView({block:"center"});
      ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(ev=>t.dispatchEvent(new MouseEvent(ev,{bubbles:true})));
    }
  });
  await sleep(400);
  return await clickByText(ctx, ["li","div","span","button","a"], new RegExp(wanted,"i"));
}

// ---------- LOGIN flows ----------
async function findLoginFieldsInPageOrFrames(page, timeoutMs=40000){
  const emailSels = ["input[type='email']","input[name='email']","#email"];
  const passSels  = ["input[type='password']","input[name='password']","#password"];
  const start = Date.now();
  while(Date.now()-start<timeoutMs){
    let eSel = await visibleSelector(page, emailSels);
    let pSel = await visibleSelector(page, passSels);
    if(eSel && pSel) return { ctx: page, emailSel: eSel, passSel: pSel };
    for(const f of page.frames()){
      try{
        eSel = await visibleSelector(f, emailSels);
        pSel = await visibleSelector(f, passSels);
        if(eSel && pSel) return { ctx: f, emailSel: eSel, passSel: pSel };
      }catch{}
    }
    // click "Login/Sign in" if visible
    await safeEval(page,()=>{
      const el = Array.from(document.querySelectorAll("a,button,div[role='button']"))
        .find(x=>/log ?in|sign ?in/i.test((x.textContent||"")));
      if(el) ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(t=>el.dispatchEvent(new MouseEvent(t,{bubbles:true})));
    });
    await sleep(500);
  }
  return null;
}

async function loginMyVip(page, shots, email, password){
  log("PHASE: myvip-login");
  await gotoWithCF(page, "https://myvip.avatrade.com/my_account", shots, "mt4_myvip_nav_cf");
  await snap(page,"mt4_00_myvip",shots,true);

  for(let i=0;i<2;i++){
    const has = await page.$("input[type='email']") || await page.$("input[name='email']");
    if(has) break;
    await sleep(800);
    await page.reload({waitUntil:"domcontentloaded"}).catch(()=>{});
    await snap(page,`mt4_00b_myvip_reload_${i+1}`,shots);
  }

  const loginCtx = await findLoginFieldsInPageOrFrames(page, 20000);
  if(!loginCtx) return false;

  await typeJS(loginCtx.ctx, loginCtx.emailSel, email);
  await typeJS(loginCtx.ctx, loginCtx.passSel, password);

  await safeEval(loginCtx.ctx,()=>{
    const btn = document.querySelector("button[type='submit']") ||
      Array.from(document.querySelectorAll("button,.btn")).find(b=>/log ?in|sign ?in/i.test(b.textContent||""));
    if(btn) ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(t=>btn.dispatchEvent(new MouseEvent(t,{bubbles:true})));
  });
  await Promise.race([ page.waitForNavigation({waitUntil:"domcontentloaded", timeout:60000}).catch(()=>{}), sleep(6000) ]);
  try{ await page.waitForNetworkIdle({idleTime:500, timeout:6000}); }catch{}
  await snap(page,"mt4_00d_myvip_after_login",shots,true);
  return true;
}

async function maybeLoginOnAccounts(page, shots, email, password){
  const ctx = await findLoginFieldsInPageOrFrames(page, 12000);
  if(!ctx) return;
  await typeJS(ctx.ctx, ctx.emailSel, email);
  await typeJS(ctx.ctx, ctx.passSel, password);
  await safeEval(ctx.ctx,()=>{
    const b = document.querySelector("button[type='submit']") || document.querySelector(".btn");
    if(b) ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(t=>b.dispatchEvent(new MouseEvent(t,{bubbles:true})));
  });
  await Promise.race([ page.waitForNavigation({waitUntil:"domcontentloaded", timeout:60000}).catch(()=>{}), sleep(6000) ]);
}

// ------------- MT4 -------------
app.post("/create-mt4", async (req,res)=>{
  if (req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ ok:false, error:"Unauthorized" });
  const { email, password } = req.body || {};
  if(!email || !password) return res.status(400).json({ ok:false, error:"Missing email/password" });

  let browser; const shots=[]; let phase="init";
  try{
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", req=>{
      const u=req.url(); const t=req.resourceType();
      if(t==="media" || /doubleclick|facebook|hotjar|segment|optimizely|fullstory|clarity|taboola|criteo/i.test(u)) req.abort();
      else req.continue();
    });
    await page.setDefaultTimeout(90000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // 1) login myvip (best-effort)
    phase="myvip-login";
    await loginMyVip(page, shots, email, password);

    // 2) accounts
    phase="goto-accounts";
    await gotoWithCF(page, "https://webtrader7.avatrade.com/crm/accounts", shots, "mt4_accounts_nav");
    try{ await page.waitForNetworkIdle({idleTime:500, timeout:10000}); }catch{}
    await waitSpinnerGone(page, 20000);
    await snap(page,"mt4_01_accounts",shots,true);
    await dismissBanners(page);
    await closeModals(page);

    // ako smo ipak na loginu → login pa dalje
    await maybeLoginOnAccounts(page, shots, email, password);
    try{ await page.waitForNetworkIdle({idleTime:500, timeout:6000}); }catch{}
    await waitSpinnerGone(page, 12000);
    await closeModals(page);

    // 3) UI detect
    phase="iframe";
    const ui = await ensureAccountsUI(page, shots);

    let frame = null, mt4Login = null;
    if(ui.mode==="iframe"){
      frame = await getFrameFromHandle(ui.handle);
      if(!frame) throw new Error("accounts iframe not found");

      await clickByText(frame, ["button","a","div","span"], /\+\s*Add an Account/i, true);
      await clickByText(frame, ["button","a","div","span"], /\+\s*Add an Account/i, false);
      await sleep(400);
      await snap(page,"mt4_06_add_iframe",shots);

      await clickByText(frame, ["button","a","div","span"], /Demo Account/i, false);
      await snap(page,"mt4_07_demo_iframe",shots,true);

      await selectOptionGeneric(frame, "CFD - MT4");
      await selectOptionGeneric(frame, "EUR");
      await snap(page,"mt4_08_set_iframe",shots);

      await clickByText(frame, ["button","a"], /^Submit$/i, false);
      await sleep(2500);
      await snap(page,"mt4_09_after_submit_iframe",shots,true);

      const credText = await safeEval(frame,()=>document.body?.innerText || "") || "";
      mt4Login = (credText.match(/Login\s*:\s*(\d{6,12})/i)||[])[1] || null;
      if(!mt4Login){
        const mt = await extractPageInfo(page);
        mt4Login = mt.login || null;
      }
      await snap(page,`mt4_10_result_${mt4Login? "ok":"miss"}`,shots,true);
    } else {
      await clickByText(page, ["button","a","div[role='button']"], /\+\s*Add an Account|Add an Account/i, false);
      await sleep(400);
      await snap(page,"mt4_spa_add_clicked",shots);

      await clickByText(page, ["button","a","div","span"], /Demo Account/i, false);
      await snap(page,"mt4_spa_demo_clicked",shots,true);

      await selectOptionGeneric(page, "CFD - MT4");
      await selectOptionGeneric(page, "EUR");
      await snap(page,"mt4_spa_set_dds",shots);

      await clickByText(page, ["button","a"], /^Submit$/i, false);
      await waitSpinnerGone(page, 15000);
      await snap(page,"mt4_spa_after_submit",shots,true);

      const txt = await safeEval(page,()=>document.body?.innerText || "") || "";
      mt4Login = (txt.match(/Login\s*:\s*(\d{6,12})/i)||[])[1] || null;
      if(!mt4Login){
        const mt = await extractPageInfo(page);
        mt4Login = mt.login || null;
      }
      await snap(page,`mt4_spa_result_${mt4Login? "ok":"miss"}`,shots,true);
    }

    const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${baseUrl}/shots/${encodeURIComponent(f)}`);
    return res.json({ ok: !!mt4Login, mt4_login: mt4Login, screenshots: screenshot_urls });

  }catch(e){
    console.error("create-mt4 error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase, screenshots:[] });
  }finally{
    try{ await browser?.close(); }catch{}
  }
});

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