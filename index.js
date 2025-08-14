// index.js — AvaTrade DEMO + MT4 (robust, CF-bypass, screenshots u /shots)
// DEBUG_SCREENSHOTS=1 => čuva PNG i loguje "SNAP: <ime>"

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
const log = (...a)=>console.log(...a);
function ts(){ return new Date().toISOString().replace(/[:.]/g,"-").slice(0,19); }

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

async function snap(page, label, shots, full=false){
  if(!DEBUG) return;
  const name = `${ts()}_${label}.png`;
  try{
    await page.screenshot({ path:name, fullPage:!!full });
    shots.push(name);
    console.log("SNAP:", name);
  }catch{}
}

async function clickJS(ctx, selector){
  const ok = await ctx.evaluate(sel=>{
    const el = document.querySelector(sel);
    if(!el) return false;
    el.scrollIntoView({block:"center"});
    for(const t of ["pointerdown","mousedown","click","pointerup","mouseup"])
      el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true}));
    return true;
  }, selector);
  return !!ok;
}
async function typeJS(ctx, selector, value){
  return await ctx.evaluate((sel,val)=>{
    const el = document.querySelector(sel); if(!el) return false;
    el.focus(); el.value=""; el.dispatchEvent(new Event("input",{bubbles:true}));
    el.value = val; el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  }, selector, value);
}

async function dismissBanners(page){
  await page.evaluate(()=>{
    // cookies
    const btn = Array.from(document.querySelectorAll("button, a, div[role='button']"))
      .find(b=>/accept/i.test(b.textContent||""));
    if(btn) btn.click();

    // Solitics popup
    const x = document.querySelector("#solitics-popup-maker .solitics-close-button");
    if(x) x.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    const pop = document.getElementById("solitics-popup-maker");
    if(pop) pop.style.display="none";
  });
}

// ---- Cloudflare-aware goto ----
async function gotoWithCF(page, url, shots, prefix, maxTries=8){
  for(let i=1;i<=maxTries;i++){
    await page.goto(url, { waitUntil:"domcontentloaded", timeout:90000 });
    await dismissBanners(page);
    await snap(page, `${prefix}_nav_${i}`, shots);

    // cf pages text
    const t = await page.evaluate(()=>document.body?.innerText || "");
    if(/unblock challenges\.cloudflare\.com/i.test(t)){
      await sleep(2500);
      continue; // retry
    }
    if(/Verifying you are human|needs to review the security/i.test(t)){
      await sleep(3000);
      continue; // retry
    }
    // otherwise we passed CF
    return true;
  }
  return false;
}

// ---- helpers ----
async function waitForAny(page, selectors, totalMs=60000){
  const start=Date.now();
  while(Date.now()-start<totalMs){
    for(const sel of selectors){
      const el = await page.$(sel);
      if(el){
        const vis = await page.evaluate(e=>!!(e.offsetParent || (e.getClientRects && e.getClientRects().length)), el);
        if(vis) return sel;
      }
    }
    await sleep(400);
  }
  throw new Error("none of selectors appeared: " + selectors.join(" | "));
}

// ==== country / phone (DEMO) ====
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
async function openCountryDropdown(page){
  const tries = [
    ".country-wrapper .vue-country-select .dropdown",
    ".country-wrapper .vue-country-select",
    "input[placeholder='Choose a country']",
    ".country-wrapper .selected-flag",
    ".country-wrapper"
  ];
  for(const sel of tries){
    if(await clickJS(page, sel)){
      await sleep(300);
      if(await page.$(".dropdown-list")) return true;
    }
  }
  return false;
}
async function pickCountry(page, countryName){
  const searchSel = ".dropdown-list input[type='search'], .dropdown-list input[role='combobox'], .dropdown-list input[aria-autocomplete='list']";
  if(await page.$(searchSel)){
    await typeJS(page, searchSel, countryName);
    await page.keyboard.press("Enter");
    return true;
  }
  const ok = await page.evaluate((name)=>{
    const list = document.querySelector(".dropdown-list") || document.body;
    function vis(el){ return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length)); }
    const items = Array.from(list.querySelectorAll("li,div")).filter(vis);
    const t = items.find(it=> (it.textContent||"").toLowerCase().includes(name.toLowerCase()));
    if(t){ t.click(); return true; }
    return false;
  }, countryName);
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

// ==== extractors ====
async function extractPageInfo(page){
  const text = await page.evaluate(()=>document.body?document.body.innerText:"");
  const excerpt = (text||"").replace(/\s+/g," ").slice(0,2000);
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
async function waitForOutcome(page, maxMs=30000){ // 30s hard-cap po zahtevu
  const start = Date.now();
  const OK = [/Your Demo Account is Being Created/i,/congratulations/i,/account application has been approved/i,/webtrader login details/i,/trade on demo/i,/login details and platforms/i];
  const BAD= [/error/i,/incorrect/i,/already used|already exists/i,/try again/i,/protection|blocked|robot|captcha/i,/not valid|invalid/i];
  let last="";
  while(Date.now()-start<maxMs){
    const t = await page.evaluate(()=>document.body?.innerText || "");
    last = t||"";
    if(OK.some(r=>r.test(last))) return {status:"success", text:last.slice(0,2000)};
    if(BAD.some(r=>r.test(last))) return {status:"error", text:last.slice(0,2000)};
    await sleep(1200);
  }
  return {status:"assumed", text:last.slice(0,2000)}; // posle 30s nastavljamo dalje
}

// -------- DEMO --------
async function smartGotoDemo(page, shots){
  const url = "https://www.avatrade.com/demo-account";
  log("PHASE: goto ->", url);
  await gotoWithCF(page, url, shots, "demo_nav_cf");
  await snap(page, "01_goto", shots, true);

  const emailCandidates = ["#input-email","input[type='email']","input[name*='mail' i]","input[placeholder*='mail' i]"];
  const passCandidates  = ["#input-password","input[type='password']","input[name*='pass' i]","input[placeholder*='password' i]"];
  const emailSel = await waitForAny(page, emailCandidates, 15000);
  const passSel  = await waitForAny(page, passCandidates, 15000);
  return { emailSel, passSel };
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
    const { emailSel, passSel } = await smartGotoDemo(page, shots);

    phase="fill";
    await typeJS(page, emailSel, email);
    await typeJS(page, passSel, password);
    await snap(page, "02_filled", shots);

    await dismissBanners(page);
    await openCountryDropdown(page).catch(()=>{});
    await pickCountry(page, country).catch(()=>{});
    await typePhoneWithKeyboard(page, rest).catch(()=>{});

    phase="submit";
    await page.evaluate((eSel,pSel)=>{
      const e=document.querySelector(eSel), p=document.querySelector(pSel);
      for(const el of [e,p]){
        if(!el) continue;
        el.dispatchEvent(new Event("input",{bubbles:true}));
        el.dispatchEvent(new Event("change",{bubbles:true}));
      }
      const b=document.querySelector("button[type='submit']") || Array.from(document.querySelectorAll("button")).find(x=>/submit|sign up|start/i.test(x.textContent||""));
      if(b) b.removeAttribute("disabled");
    }, emailSel, passSel);
    await clickJS(page, "button[type='submit']") || await clickJS(page, "button");
    await Promise.race([
      page.waitForNavigation({waitUntil:"domcontentloaded", timeout:20000}).catch(()=>{}),
      sleep(8000),
    ]);
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
    return res.status(200).json({ // i u grešci se vraćamo 200 da bot nastavi MT4 (po zahtevu)
      ok:true, note:`force-continue (${phase})`, screenshots:[]
    });
  }finally{
    try{ await browser?.close(); }catch{}
  }
});

// ------------- MT4 -------------
async function closeModals(page){
  await page.evaluate(()=>{
    // welcome modal
    for(const sel of ["button[aria-label='Close']", ".modal-header .close", "button.close", "[data-dismiss='modal']"]){
      const b=document.querySelector(sel);
      if(b){ b.click(); }
    }
    // any overlay with role=dialog
    const dlg = document.querySelector("[role='dialog']");
    if(dlg){ dlg.style.display="none"; }
  });
}

async function waitSpinnerGone(page, ms=30000){
  const start=Date.now();
  while(Date.now()-start<ms){
    const has = await page.evaluate(()=>{
      const sel=[".spinner",".loading",".lds-ring",".lds-roller",".preloader",".MuiBackdrop-root",".ant-spin"];
      return sel.some(s=> document.querySelector(s));
    });
    if(!has) return true;
    await sleep(800);
  }
  return false;
}

async function ensureAccountsUI(page, shots){
  // prvo iframe varijanta
  const iframe = await page.$('#my_account, iframe[src*="avacrm"]');
  if(iframe) return { mode:"iframe", handle: iframe };

  // probaj da li postoji +Add an Account dugme u glavnom DOM-u
  const hasAdd = await page.evaluate(()=>{
    const btn = Array.from(document.querySelectorAll("button,a,div[role='button']"))
      .find(b=>/\+\s*Add an Account|Add an Account/i.test(b.textContent||""));
    return !!btn;
  });
  if(hasAdd) return { mode:"spa", handle: null };

  // pričekaj malo, reload ako treba
  await waitSpinnerGone(page, 15000);
  await snap(page,"mt4_iframe_retry_1",shots);
  const iframe2 = await page.$('#my_account, iframe[src*="avacrm"]');
  if(iframe2) return { mode:"iframe", handle: iframe2 };

  await snap(page,"mt4_iframe_retry_2",shots);
  const hasAdd2 = await page.evaluate(()=>{
    const btn = Array.from(document.querySelectorAll("button,a,div[role='button']"))
      .find(b=>/\+\s*Add an Account|Add an Account/i.test(b.textContent||""));
    return !!btn;
  });
  if(hasAdd2) return { mode:"spa", handle: null };

  await snap(page,"mt4_iframe_retry_3",shots);
  throw new Error("accounts UI not available");
}

async function getFrameFromHandle(handle){
  try{ const f = await handle.contentFrame(); return f || null; }catch{ return null; }
}

async function clickByText(pageOrFrame, selectors, regex, hover=false){
  const res = await pageOrFrame.evaluate((sels, pattern, hov)=>{
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
  }, selectors, regex.source, hover);
  return !!res;
}

async function selectOptionGeneric(pageOrFrame, wanted){
  // <select>
  const okSelect = await pageOrFrame.evaluate((txt)=>{
    const sels = Array.from(document.querySelectorAll("select"));
    for(const s of sels){
      const opt = Array.from(s.options).find(o=> (o.textContent||"").toLowerCase().includes(txt.toLowerCase()));
      if(opt){ s.value = opt.value; s.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    }
    return false;
  }, wanted);
  if(okSelect) return true;

  // custom dropdown
  await pageOrFrame.evaluate(()=>{
    const toggles = Array.from(document.querySelectorAll("[role='combobox'], .Select-control, .dropdown, .select, .v-select, .css-1hwfws3, .css-1wa3eu0-placeholder, .ant-select-selector"));
    const t = toggles.find(x=> !!(x.offsetParent || (x.getClientRects && x.getClientRects().length)));
    if(t){
      t.scrollIntoView({block:"center"});
      ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(ev=>t.dispatchEvent(new MouseEvent(ev,{bubbles:true})));
    }
  });
  await sleep(400);
  return await clickByText(pageOrFrame, ["li","div","span","button","a"], new RegExp(wanted,"i"));
}

async function loginMyVip(page, shots, email, password){
  log("PHASE: myvip-login");
  await gotoWithCF(page, "https://myvip.avatrade.com/my_account", shots, "mt4_myvip_nav_cf");

  await snap(page,"mt4_00_myvip",shots,true);

  // login forma (nekad ne učita odmah – reload)
  for(let i=0;i<3;i++){
    const hasInputs = await page.$("input[type='email']") || await page.$("input[name='email']");
    if(hasInputs) break;
    await sleep(1500);
    await page.reload({waitUntil:"domcontentloaded"}).catch(()=>{});
    await snap(page,`mt4_00b_myvip_reload_${i+1}`,shots);
  }

  const mailSel = await waitForAny(page, ["input[type='email']","input[name='email']","#email"], 40000);
  const passSel = await waitForAny(page, ["input[type='password']","input[name='password']","#password"], 40000);
  await typeJS(page, mailSel, email);
  await typeJS(page, passSel, password);
  await clickJS(page, "button[type='submit'], .btn, button");
  await Promise.race([
    page.waitForNavigation({waitUntil:"domcontentloaded", timeout:60000}).catch(()=>{}),
    sleep(6000),
  ]);
  await snap(page,"mt4_00d_myvip_after_login",shots,true);
}

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

    // 1) login myvip
    phase="myvip-login";
    await loginMyVip(page, shots, email, password);

    // 2) accounts
    phase="goto-accounts";
    await gotoWithCF(page, "https://webtrader7.avatrade.com/crm/accounts", shots, "mt4_accounts_nav");
    await waitSpinnerGone(page, 20000);
    await snap(page,"mt4_01_accounts",shots,true);
    await dismissBanners(page);
    await closeModals(page);

    // 3) UI detect
    phase="iframe";
    const ui = await ensureAccountsUI(page, shots);

    let frame = null;
    if(ui.mode==="iframe"){
      frame = await getFrameFromHandle(ui.handle);
      if(!frame) throw new Error("accounts iframe not found");
      // hover/klik Add an Account
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

      const credText = await frame.evaluate(()=>document.body?.innerText || "");
      let mt4Login = (credText.match(/Login\s*:\s*(\d{6,12})/i)||[])[1] || null;
      if(!mt4Login){
        const mt = await extractPageInfo(page);
        mt4Login = mt.login || null;
      }
      await snap(page,`mt4_10_result_${mt4Login? "ok":"miss"}`,shots,true);

      const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
      const screenshot_urls = shots.map(f => `${baseUrl}/shots/${encodeURIComponent(f)}`);
      return res.json({ ok: !!mt4Login, mt4_login: mt4Login, screenshots: screenshot_urls });
    }

    // ---- SPA (bez iframe-a) ----
    phase="spa-flow";
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

    // čitanje logina sa stranice
    let txt = await page.evaluate(()=>document.body?.innerText || "");
    let mt4Login = (txt.match(/Login\s*:\s*(\d{6,12})/i)||[])[1] || null;
    if(!mt4Login){
      const mt = await extractPageInfo(page);
      mt4Login = mt.login || null;
    }
    await snap(page,`mt4_spa_result_${mt4Login? "ok":"miss"}`,shots,true);

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