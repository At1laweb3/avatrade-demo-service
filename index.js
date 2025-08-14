// index.js — AvaTrade demo + MT4 (Cloudflare-safe, SPA/iframe fallback, bogati snapovi)
// ENV: PORT, PUPPETEER_SHARED_SECRET, DEBUG_SCREENSHOTS=1

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
const log = (...a) => console.log(...a);
const ts  = () => new Date().toISOString().replace(/[:.]/g,"-").slice(0,19);

async function launchBrowser(){
  return puppeteer.launch({
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

async function snap(page, label, shots, full=false){
  if(!DEBUG) return;
  const name = `${ts()}_${label}.png`;
  try{ await page.screenshot({ path:name, fullPage:!!full }); shots.push(name); console.log("SNAP:", name);}catch{}
}

async function clickJS(ctx, selector){
  return await ctx.evaluate(sel=>{
    const el = document.querySelector(sel);
    if(!el) return false;
    el.scrollIntoView({block:"center", inline:"center"});
    for(const t of ["pointerdown","mousedown","click","pointerup","mouseup"]){
      el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true}));
    }
    return true;
  }, selector);
}
async function typeJS(ctx, selector, val){
  return await ctx.evaluate((sel,v)=>{
    const el = document.querySelector(sel);
    if(!el) return false;
    el.focus(); el.value="";
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.value=v;
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  }, selector, val);
}
async function waitForAny(page, selectors, totalMs=60000){
  const t0=Date.now();
  while(Date.now()-t0<totalMs){
    for(const sel of selectors){
      const h = await page.$(sel);
      if(h){
        const vis = await page.evaluate(e => !!(e.offsetParent || (e.getClientRects && e.getClientRects().length)), h);
        if(vis) return sel;
      }
    }
    await sleep(300);
  }
  throw new Error("none of selectors appeared: "+selectors.join(" | "));
}
async function dismissBanners(ctx){
  await ctx.evaluate(()=>{
    // cookie accept
    const labels=["accept","i agree","allow all"];
    const btn = Array.from(document.querySelectorAll("button,a,div[role='button']"))
      .find(b=> labels.some(w=> (b.textContent||"").toLowerCase().includes(w)));
    if(btn) btn.click();

    // Solitics popup
    const x = document.querySelector("#solitics-popup-maker .solitics-close-button");
    if(x) x.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    const pop = document.getElementById("solitics-popup-maker");
    if(pop) pop.style.display="none";
  });
}

// ————— Cloudflare helpers —————
async function isCloudflare(page){
  const html = await page.content();
  return /cloudflare|review the security|challenges\.cloudflare\.com/i.test(html);
}
async function passCloudflare(page, shots, tag, maxLoops=6){
  for(let i=0;i<maxLoops;i++){
    if(!(await isCloudflare(page))) return true;
    await snap(page, `${tag}_cf_${i+1}`, shots, true);
    await sleep(2500 + i*700);
    try{ await page.reload({waitUntil:"domcontentloaded"}); }catch{}
  }
  return !(await isCloudflare(page));
}

// ————— generic text click/select on PAGE or FRAME —————
async function clickByText(ctx, tagList, regex, hoverOnly=false){
  return await ctx.evaluate((tags, pattern, hover)=>{
    const rx=new RegExp(pattern,"i");
    const els = Array.from(document.querySelectorAll(tags.join(",")));
    const el  = els.find(e=>{
      const t=(e.textContent||"").trim();
      const vis=!!(e.offsetParent||(e.getClientRects&&e.getClientRects().length));
      return vis && rx.test(t);
    });
    if(!el) return false;
    el.scrollIntoView({block:"center"});
    if(hover){
      el.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}));
      el.dispatchEvent(new MouseEvent("mouseenter",{bubbles:true}));
      return true;
    }
    for(const t of ["pointerdown","mousedown","click","pointerup","mouseup"])
      el.dispatchEvent(new MouseEvent(t,{bubbles:true}));
    return true;
  }, tagList, regex.source, hoverOnly);
}
async function selectOptionByText(ctx, optionText){
  const okSelect = await ctx.evaluate((wanted)=>{
    const sels = Array.from(document.querySelectorAll("select"));
    for(const s of sels){
      const opt = Array.from(s.options).find(o=>(o.textContent||"").trim().toLowerCase().includes(wanted.toLowerCase()));
      if(opt){ s.value=opt.value; s.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    }
    return false;
  }, optionText);
  if(okSelect) return true;

  // custom dropdown
  await ctx.evaluate(()=>{
    const toggles = Array.from(document.querySelectorAll(
      "[role='combobox'], .Select-control, .dropdown, .select, .v-select, .css-1hwfws3, .css-1wa3eu0-placeholder"
    ));
    const t = toggles.find(x=>!!(x.offsetParent||(x.getClientRects && x.getClientRects().length)));
    if(t){
      t.scrollIntoView({block:"center"});
      for(const ev of ["pointerdown","mousedown","click","pointerup","mouseup"])
        t.dispatchEvent(new MouseEvent(ev,{bubbles:true}));
    }
  });
  await sleep(400);
  return await clickByText(ctx, ["li","div","span","button","a"], new RegExp(optionText,"i"));
}
async function waitOverlayGone(ctx, timeout=90000){
  const t0=Date.now();
  while(Date.now()-t0<timeout){
    const has = await ctx.evaluate(()=>{
      const cand = Array.from(document.querySelectorAll(
        ".spinner, .loading, [class*='loader'], [class*='overlay'], [role='progressbar']"
      ));
      return cand.some(el=>{
        const vis=!!(el.offsetParent||(el.getClientRects && el.getClientRects().length));
        return vis;
      });
    });
    if(!has) return true;
    await sleep(700);
  }
  return false;
}
async function closeModals(ctx){
  await ctx.evaluate(()=>{
    // welcome modal "X"
    const xs = Array.from(document.querySelectorAll("button, .close, [aria-label='Close'], [class*='close']"));
    const x = xs.find(b=>{
      const t=(b.getAttribute("aria-label")||b.textContent||"").trim().toLowerCase();
      return t==="close" || t==="×" || t==="x";
    });
    if(x){ x.click(); }
  });
}

// ————— phone helpers (demo) —————
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
  const tries=[
    ".country-wrapper .vue-country-select .dropdown",
    ".country-wrapper .vue-country-select",
    "input[placeholder='Choose a country']",
    ".country-wrapper .selected-flag",
    ".country-wrapper"
  ];
  for(const sel of tries){
    if(await clickJS(page, sel)){ await sleep(300); if(await page.$(".dropdown-list")) return true; }
  }
  return false;
}
async function pickCountry(page, countryName){
  const searchSel = ".dropdown-list input[type='search'], .dropdown-list input[role='combobox'], .dropdown-list input[aria-autocomplete='list']";
  if(await page.$(searchSel)){
    await typeJS(page, searchSel, countryName); await page.keyboard.press("Enter"); return true;
  }
  const ok = await page.evaluate((name)=>{
    const list=document.querySelector(".dropdown-list")||document.body;
    const items=Array.from(list.querySelectorAll("li.dropdown-item, li, div.dropdown-item"));
    const it = items.find(i=> (i.textContent||"").toLowerCase().includes(name.toLowerCase()));
    if(it){ it.click(); return true; }
    return false;
  }, countryName);
  return !!ok;
}
async function setPhoneDialCountry(page, countryName){
  const openTries = [".iti__flag-container",".vti__dropdown",".vti__selection",".phone-wrapper .dropdown",".phone-wrapper"];
  for(const sel of openTries){ if(await page.$(sel)){ await clickJS(page, sel); await sleep(250); break; } }
  const picked = await page.evaluate((name)=>{
    const lists=[ ".iti__country-list",".vti__dropdown-list",".dropdown-menu",".dropdown-list" ]
      .map(q=>document.querySelector(q)).filter(Boolean);
    for(const l of lists){
      const el = Array.from(l.querySelectorAll("li,div")).find(x=>/serbia|србија|\+381/i.test(x.textContent||""));
      if(el){ el.dispatchEvent(new MouseEvent("click",{bubbles:true})); return true; }
    }
    return false;
  }, countryName||"Serbia");
  return picked;
}
async function typePhoneWithKeyboard(page, localDigits){
  const sels=["input[type='tel']","input[placeholder*='phone' i]","input[name*='phone' i]","#input-phone"];
  for(const sel of sels){
    if(await page.$(sel)){
      await page.click(sel, { clickCount: 3 });
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.type(sel, localDigits, { delay: 25 });
      await page.keyboard.press("Tab");
      return true;
    }
  }
  return false;
}

// ————— demo extractor / outcome —————
async function extractPageInfo(page){
  const text = await page.evaluate(()=>document.body?document.body.innerText:"");
  const excerpt=(text||"").replace(/\s+/g," ").slice(0,2000);
  const out={found:false, login:null, server:null, password:null, excerpt};
  if(!text) return out;
  const login  = text.match(/(?:MT[45]\s*login|Login)\s*[:\-]?\s*(\d{6,12})/i);
  const server = text.match(/Server\s*[:\-]?\s*([A-Za-z0-9._\-\s]+?(?:Demo|Live)?)/i);
  const pass   = text.match(/Password\s*[:\-]?\s*([^\s\r\n]+)/i);
  if(login)  out.login=login[1];
  if(server) out.server=server[1].trim();
  if(pass)   out.password=pass[1];
  if(out.login && out.server) out.found=true;
  return out;
}
async function waitForOutcome(page, maxMs=60000){
  const start=Date.now();
  const SUCCESS=[/congratulations/i,/account application has been approved/i,/webtrader login details/i,/trade on demo/i,/login details and platforms/i,/Your Demo Account is Being Created/i];
  const ERROR=[/error/i,/incorrect/i,/already used/i,/already exists/i,/try again/i,/protection/i,/blocked/i,/robot/i,/captcha/i,/not valid/i,/invalid/i];
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

// ————— smart goto (demo) —————
async function smartGotoDemo(page, shots){
  const urls=[
    "https://www.avatrade.com/demo-account",
    "https://www.avatrade.com/trading-account/demo-trading-account",
  ];
  for(const u of urls){
    log("PHASE: goto ->", u);
    await page.goto(u, { waitUntil:"domcontentloaded", timeout:90000 });
    await passCloudflare(page, shots, "demo_nav", 8);
    await dismissBanners(page);
    await snap(page,"01_goto",shots,true);
    try{
      const emailSel = await waitForAny(page, ["#input-email","input[type='email']","input[name*='mail' i]","input[placeholder*='mail' i]"], 8000);
      const passSel  = await waitForAny(page, ["#input-password","input[type='password']","input[name*='pass' i]","input[placeholder*='password' i]"], 8000);
      return { emailSel, passSel };
    }catch{}
  }
  throw new Error("Demo form not found on known URLs");
}

// ————— ROUTES —————
app.post("/create-demo", async (req,res)=>{
  if(req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ok:false,error:"Unauthorized"});
  const { name, email, password, phone, country="Serbia" } = req.body||{};
  if(!name || !email || !password || !phone) return res.status(400).json({ok:false,error:"Missing fields"});

  const normPhone = normalizePhone(phone, country.toLowerCase().includes("serb")?"+381":"+387");
  const { rest }  = splitIntl(normPhone);

  let browser; const shots=[]; let phase="init";
  try{
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", r=>{
      const u=r.url(); const t=r.resourceType();
      if(t==="media" || /doubleclick|facebook|hotjar|segment|optimizely|fullstory|clarity|taboola|criteo/i.test(u)) r.abort();
      else r.continue();
    });
    await page.setDefaultTimeout(90000);
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

    phase="submit";
    await dismissBanners(page);
    await page.evaluate((eSel,pSel)=>{
      const e=document.querySelector(eSel), p=document.querySelector(pSel);
      for(const el of [e,p]) if(el){ el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); el.blur(); }
      const b = document.querySelector("button[type='submit']") || Array.from(document.querySelectorAll("button")).find(x=>/submit|sign up|start/i.test(x.textContent||""));
      if(b) b.removeAttribute("disabled");
    }, emailSel, passSel);
    await clickJS(page, "button[type='submit']") || await clickJS(page, "button");
    await Promise.race([ page.waitForNavigation({waitUntil:"domcontentloaded", timeout:20000}).catch(()=>{}), sleep(9000) ]);
    await snap(page,"04_after_submit",shots,true);

    phase="outcome";
    const outcome = await waitForOutcome(page, 60000);
    await snap(page, `05_outcome_${outcome.status}`, shots);

    const base = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${base}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok: outcome.status==="success",
      note: `Outcome: ${outcome.status}`,
      url: page.url(),
      outcome_excerpt: outcome.text?.slice(0,500)||"",
      screenshots: screenshot_urls
    });

  }catch(e){
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ok:false,error:String(e),phase});
  }finally{ try{ await browser?.close(); }catch{} }
});

// ——— MT4 helpers
async function ensureLoggedInMyVip(page, shots, email, password){
  // idemo na myvip login
  log("PHASE: myvip-login");
  await page.goto("https://myvip.avatrade.com/my_account", { waitUntil:"domcontentloaded", timeout:90000 });
  await passCloudflare(page, shots, "mt4_myvip_nav", 8);
  await snap(page,"mt4_00_myvip",shots,true);

  // ako smo već ulogovani, biće redirect drugo — pokušaj naći polja
  const hasEmail = await page.$("input[type='email'], #email, input[name='email']");
  const hasPass  = await page.$("input[type='password'], #password, input[name='password']");

  if(hasEmail && hasPass){
    await typeJS(page, "input[type='email'], #email, input[name='email']", email);
    await typeJS(page, "input[type='password'], #password, input[name='password']", password);
    await snap(page,"mt4_00b_myvip_filled",shots);
    await clickJS(page, "button[type='submit'], .btn, button");
    await Promise.race([ page.waitForNavigation({waitUntil:"domcontentloaded", timeout:60000}).catch(()=>{}), sleep(6000) ]);
    await snap(page,"mt4_00d_myvip_after_login",shots,true);
  }
}

// vraća “ctx” (page ili frame) za CRM/accounts
async function getAccountsCtx(page, shots){
  log("PHASE: goto-accounts");
  await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil:"domcontentloaded", timeout:90000 });
  await passCloudflare(page, shots, "mt4_accounts_nav", 8);
  await snap(page,"mt4_01_accounts",shots,true);

  // čekaj da se SPA učita / overlay nestane
  await waitOverlayGone(page, 90000);
  await dismissBanners(page);
  await closeModals(page);

  // pokušaj da nađeš iframe
  for(let i=1;i<=3;i++){
    const handle = await page.$('#my_account, iframe[src*="avacrm"]');
    if(handle){
      const frame = await handle.contentFrame();
      if(frame){
        await snap(page,`mt4_iframe_ok_${i}`,shots);
        return frame;
      }
    }
    await snap(page,`mt4_iframe_retry_${i}`,shots);
    await sleep(1500);
  }

  // fallback: nema iframe – radimo direktno na PAGE kontekstu
  const hasAdd = await page.evaluate(()=>{
    const els = Array.from(document.querySelectorAll("button,a,div[role='button']"));
    return els.some(e=>/\+\s*add an account/i.test(e.textContent||""));
  });
  if(hasAdd) return page;

  throw new Error("accounts UI not available");
}

app.post("/create-mt4", async (req,res)=>{
  if(req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ok:false,error:"Unauthorized"});
  const { email, password } = req.body||{};
  if(!email || !password) return res.status(400).json({ok:false,error:"Missing email/password"});

  let browser; const shots=[]; let phase="init";
  try{
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", r=>{
      const u=r.url(); const t=r.resourceType();
      if(t==="media" || /doubleclick|facebook|hotjar|segment|optimizely|fullstory|clarity|taboola|criteo/i.test(u)) r.abort();
      else r.continue();
    });
    await page.setDefaultTimeout(90000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // 1) login na myvip (ako treba)
    phase="myvip-login";
    await ensureLoggedInMyVip(page, shots, email, password);

    // 2) accounts UI (iframe ili SPA)
    phase="iframe";
    const ctx = await getAccountsCtx(page, shots);

    // zatvori potencijalne modale unutar ctx
    await closeModals(ctx);

    // 3) + Add an Account → Demo Account
    phase="add-account";
    await clickByText(ctx, ["button","a","div","span"], /\+\s*Add an Account/i, false) || await clickByText(ctx, ["button","a","div","span"], /Add an Account/i, false);
    await sleep(600);
    await clickByText(ctx, ["button","a","div","span","li"], /Demo Account/i, false);
    await snap(page,"mt4_07_click_demo",shots,true);

    // 4) set “CFD - MT4” i “EUR”
    phase="dropdowns";
    await selectOptionByText(ctx, "CFD - MT4");
    await selectOptionByText(ctx, "EUR");
    await snap(page,"mt4_08_dropdowns_set",shots);

    // 5) Submit
    phase="submit";
    await clickByText(ctx, ["button","a","div"], /^Submit$/i, false);
    await sleep(2500);
    await snap(page,"mt4_09_after_submit",shots,true);

    // 6) Parse kredencijale
    phase="extract";
    let text = await (ctx.evaluate ? ctx.evaluate(()=>document.body?.innerText||"") : page.evaluate(()=>document.body?.innerText||""));
    let login = (text.match(/Login\s*:\s*(\d{6,12})/i)||[])[1] || null;
    if(!login){
      const mt = await extractPageInfo(page);
      login = mt.login || null;
    }
    await snap(page,`mt4_10_result_${login?"ok":"miss"}`,shots,true);

    const base = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${base}/shots/${encodeURIComponent(f)}`);

    return res.json({ ok: !!login, mt4_login: login, screenshots: screenshot_urls });

  }catch(e){
    console.error("create-mt4 error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase, screenshots: [] });
  }finally{ try{ await browser?.close(); }catch{} }
});

app.get("/", (_req,res)=>res.send("AvaTrade Demo Service live"));
app.use("/shots", (req,res)=>{
  const filename = req.path.replace(/^\/+/, "");
  if(!/\.png$/i.test(filename)) return res.status(400).send("bad file");
  const full = path.join(process.cwd(), filename);
  if(!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

app.listen(PORT, ()=>console.log("Listening on", PORT));