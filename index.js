// index.js — AvaTrade demo + MT4 kreiranje (otpornije varijante + screenshots u logu)
// DEBUG_SCREENSHOTS=1 -> pravi PNG-ove i ispisuje "SNAP: <naziv>"
// Rute: /create-demo i /create-mt4

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

function ts(){ return new Date().toISOString().replace(/[:.]/g,"-").slice(0,19); }

// ---------- LAUNCH ----------
async function launchBrowser() {
  return await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
      "--disable-gpu","--no-zygote","--window-size=1280,1000",
      "--renderer-process-limit=1","--js-flags=--max-old-space-size=256",
      "--no-first-run","--no-default-browser-check",
    ],
    defaultViewport: { width: 1280, height: 1000 },
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
  const ok = await ctx.evaluate((sel)=>{
    const el = document.querySelector(sel);
    if(!el) return false;
    el.scrollIntoView({block:"center", inline:"center"});
    const evts=["pointerdown","mousedown","click","pointerup","mouseup"];
    for(const t of evts) el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));
    return true;
  }, selector);
  return !!ok;
}

async function typeJS(ctx, selector, value){
  return await ctx.evaluate((sel,val)=>{
    const el = document.querySelector(sel);
    if(!el) return false;
    el.focus(); el.value="";
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.value = val;
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  }, selector, value);
}

async function dismissBanners(page){
  await page.evaluate(()=>{
    // generična dugmad
    const btns = Array.from(document.querySelectorAll("button,a,div[role='button']"));
    const el = btns.find(b=>/accept|got it|agree|allow|close|not now|ok/i.test((b.textContent||"")));
    if(el) el.click();

    // Solitics modal (X dugme)
    const x = document.querySelector("#solitics-popup-maker .solitics-close-button");
    if(x) (x).dispatchEvent(new MouseEvent("click",{bubbles:true}));
    // ako i dalje stoji — skloni ga na silu
    const pop = document.getElementById("solitics-popup-maker");
    if(pop) pop.style.display="none";
  });
}

// helper: čekaj bilo koji selektor iz liste (vidljiv)
async function waitForAny(page, selectors, totalMs=60000){
  const start = Date.now();
  while(Date.now()-start < totalMs){
    for(const sel of selectors){
      const el = await page.$(sel);
      if(el){
        // proveri vidljivost
        const vis = await page.evaluate(e => !!(e.offsetParent || (e.getClientRects && e.getClientRects().length)), el);
        if(vis) return sel;
      }
    }
    await sleep(400);
  }
  throw new Error("none of selectors appeared: " + selectors.join(" | "));
}

// ==== country helpers (create-demo) ====
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
      await sleep(400);
      if(await page.$(".dropdown-list")) return true;
    }
  }
  await page.evaluate(()=>{
    const hits=["choose a country","country","select country"];
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
  if(await page.$(searchSel)){
    await typeJS(page, searchSel, countryName);
    await page.keyboard.press("Enter");
    return true;
  }
  if(await page.$(".dropdown-list li.dropdown-item .vti__flag.rs")){
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

// ==== telefon helpers (create-demo) ====
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
  const openTries = [".iti__flag-container", ".vti__dropdown", ".vti__selection", ".phone-wrapper .dropdown", ".phone-wrapper"];
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

// ==== MT extractors ====
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

async function waitForOutcome(page, maxMs=60000){
  const start=Date.now();
  const SUCCESS=[/congratulations/i,/account application has been approved/i,/webtrader login details/i,/trade on demo/i,/login details and platforms/i];
  const ERROR=[/error/i,/incorrect/i,/already used/i,/already exists/i,/try again/i,/protection/i,/blocked/i,/robot/i,/captcha/i,/not valid/i,/invalid/i];
  let last="";
  while(Date.now()-start<maxMs){
    const t = await page.evaluate(()=>document.body?document.body.innerText:"");
    last = t||"";
    if(SUCCESS.some(r=>r.test(last))) return {status:"success", text:last.slice(0,2000)};
    if(ERROR.some(r=>r.test(last)))   return {status:"error",   text:last.slice(0,2000)};
    await sleep(1500);
  }
  return {status:"timeout", text:last.slice(0,2000)};
}

// smartGoto – proba više varijanti stranice sa formom
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

    // pokušaj odmah da nađeš email/password
    const emailCandidates = ["#input-email","input[type='email']","input[name*='mail' i]","input[placeholder*='mail' i]"];
    const passCandidates  = ["#input-password","input[type='password']","input[name*='pass' i]","input[placeholder*='password' i]"];

    try{
      const emailSel = await waitForAny(page, emailCandidates, 8000);
      const passSel  = await waitForAny(page, passCandidates, 8000);
      return { emailSel, passSel };
    }catch{
      // ništa — probaćemo sledeći URL
    }
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

  let browser, phase="init";
  const shots=[];

  try{
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url(); const t=req.resourceType();
      if (t==="media" || /doubleclick|facebook|hotjar|segment|optimizely|fullstory|clarity|taboola|criteo/i.test(u)) req.abort();
      else req.continue();
    });
    await page.setDefaultTimeout(90000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // otvori demo formu (više varijanti)
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
      const b=document.querySelector("button[type='submit']") || Array.from(document.querySelectorAll("button")).find(b=>/submit|sign up|start/i.test(b.textContent||""));
      if(b) b.removeAttribute("disabled");
    }, emailSel, passSel);

    await dismissBanners(page);
    await sleep(400);
    // klik Submit
    const clicked = await clickJS(page, "button[type='submit']") || await clickJS(page, "button");
    await Promise.race([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:20000 }).catch(()=>{}),
      sleep(9000)
    ]);
    await snap(page,"04_after_submit",shots,true);

    phase="outcome";
    const outcome = await waitForOutcome(page, 60000);
    await snap(page, `05_outcome_${outcome.status}`, shots);

    phase="extract";
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
      screenshots: screenshot_urls
    });

  }catch(e){
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase });
  }finally{
    try{ await browser?.close(); }catch{}
  }
});

// ===== helpers za MT4 (CRM/iframe) =====
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
    const toggles = Array.from(document.querySelectorAll("[role='combobox'], .Select-control, .dropdown, .select, .v-select, .css-1hwfws3"));
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

// ===== /create-mt4 =====
app.post("/create-mt4", async (req, res)=>{
  if (req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ ok:false, error:"Unauthorized" });

  const { email, password } = req.body || {};
  if(!email || !password) return res.status(400).json({ ok:false, error:"Missing email/password" });

  let browser; const shots=[]; let phase="init";
  try{
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setRequestInterception(true);
    page.on("request", req => {
      const u = req.url(); const t=req.resourceType();
      if (t==="media" || /doubleclick|facebook|hotjar|segment|optimizely|fullstory|clarity|taboola|criteo/i.test(u)) req.abort();
      else req.continue();
    });

    await page.setDefaultTimeout(90000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase="goto-accounts"; log("PHASE:", phase);
    await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil:"domcontentloaded", timeout:90000 });
    await dismissBanners(page);
    await snap(page,"mt4_01_accounts", shots, true);

    // Ako nema iframea -> login
    phase="maybe-login";
    const hasIframe = await page.$('#my_account, iframe[src*="avacrm"]');
    if(!hasIframe){
      const emailSel = await waitForAny(page, ["input[type='email']","input[name='email']","#email"], 60000);
      const passSel  = await waitForAny(page, ["input[type='password']","input[name='password']","#password"], 60000);
      await typeJS(page, emailSel, email);
      await typeJS(page, passSel, password);
      await snap(page,"mt4_02_login_filled",shots);
      await clickJS(page, "button[type='submit'], .btn, button");
      await Promise.race([
        page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:60000 }).catch(()=>{}),
        sleep(8000),
      ]);
      await snap(page,"mt4_03_after_login",shots,true);
      await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil:"domcontentloaded", timeout:90000 });
      await snap(page,"mt4_04_accounts_again",shots,true);
    }

    phase="iframe"; log("PHASE:", phase);
    const frame = await getMyAccountFrame(page);
    await snap(page,"mt4_05_iframe_loaded",shots);

    // 1) hover Add an Account
    phase="hover-add"; log("PHASE:", phase);
    const hovered = await clickByText(frame, ["button","a","div","span"], /\+\s*Add an Account/i, true);
    await snap(page,"mt4_06_hover_add",shots);
    if(!hovered) await clickByText(frame, ["button","a","div","span"], /\+\s*Add an Account/i, false);
    await sleep(500);

    // 2) klik Demo Account
    phase="click-demo"; log("PHASE:", phase);
    await clickByText(frame, ["button","a","div","span"], /Demo Account/i, false);
    await snap(page,"mt4_07_click_demo",shots,true);

    // 3) set CFD - MT4 + EUR
    phase="set-dropdowns"; log("PHASE:", phase);
    await frame.waitForSelector("body", { timeout: 90000 });
    await selectOptionByText(frame, "CFD - MT4");
    await selectOptionByText(frame, "EUR");
    await snap(page,"mt4_08_dropdowns_set",shots);

    // 4) Submit
    phase="submit"; log("PHASE:", phase);
    await clickByText(frame, ["button","a"], /^Submit$/i, false);
    await sleep(2000);
    await snap(page,"mt4_09_after_submit",shots,true);

    // 5) extract
    phase="extract"; log("PHASE:", phase);
    const credText = await frame.evaluate(()=>document.body?.innerText || "");
    let login = (credText.match(/Login\s*:\s*(\d{6,12})/i)||[])[1] || null;
    if(!login){
      const mt = await extractPageInfo(page);
      login = mt.login || null;
    }
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

app.get("/", (_req,res)=>res.send("AvaTrade Demo Service live"));

app.use("/shots", (req,res)=>{
  const filename = req.path.replace(/^\/+/, "");
  if(!/\.png$/i.test(filename)) return res.status(400).send("bad file");
  const full = path.join(process.cwd(), filename);
  if(!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

app.listen(PORT, ()=>console.log("Listening on", PORT));