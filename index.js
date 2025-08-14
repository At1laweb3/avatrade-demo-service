// index.js — AvaTrade demo + MT4 (iframe-or-page fallback + DY/CF fixes + retries)
// DEBUG_SCREENSHOTS=1 -> pravi PNG-ove i ispisuje "SNAP: <naziv>"
// Rute: /create-demo, /create-mt4, /shots/<file.png>

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
const ts = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

// ---------- launch ----------
async function launchBrowser() {
  return await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--no-zygote", "--window-size=1280,1000",
      "--renderer-process-limit=1", "--js-flags=--max-old-space-size=256",
      "--no-first-run", "--no-default-browser-check",
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

// ---------- tiny DOM helpers (work with Page OR Frame) ----------
function ctxEval(ctx, fn, ...args){ return ctx.evaluate(fn, ...args); }
async function clickByTextCtx(ctx, tagList, regex, hoverOnly=false){
  return await ctxEval(ctx, (tags, pattern, hover)=>{
    const rx=new RegExp(pattern,"i");
    const els=[...document.querySelectorAll(tags.join(","))];
    const el=els.find(e=>{
      const t=(e.textContent||"").trim();
      const vis=!!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
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
async function selectOptionByTextCtx(ctx, optionText){
  const okSelect = await ctxEval(ctx,(wanted)=>{
    const sels=[...document.querySelectorAll("select")];
    for(const s of sels){
      const opt=[...s.options].find(o=>o.textContent.trim().toLowerCase().includes(wanted.toLowerCase()));
      if(opt){ s.value=opt.value; s.dispatchEvent(new Event("change",{bubbles:true})); return true; }
    }
    return false;
  }, optionText);
  if(okSelect) return true;

  await ctxEval(ctx,()=>{
    const toggles=[...document.querySelectorAll("[role='combobox'], .Select-control, .dropdown, .select, .v-select, .css-1hwfws3, .css-1wa3eu0-placeholder")];
    const t=toggles.find(x=>!!(x.offsetParent || (x.getClientRects && x.getClientRects().length)));
    if(t){
      t.scrollIntoView({block:"center"});
      ["pointerdown","mousedown","click","pointerup","mouseup"].forEach(ev=>t.dispatchEvent(new MouseEvent(ev,{bubbles:true})));
    }
  });
  await sleep(400);
  const picked = await clickByTextCtx(ctx, ["li","div","span","button","a"], new RegExp(optionText,"i"));
  return !!picked;
}

async function clickJS(ctx, selector){
  const ok=await ctxEval(ctx,(sel)=>{
    const el=document.querySelector(sel);
    if(!el) return false;
    el.scrollIntoView({block:"center",inline:"center"});
    for(const t of ["pointerdown","mousedown","click","pointerup","mouseup"])
      el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true}));
    return true;
  }, selector);
  return !!ok;
}
async function typeJS(ctx, selector, value){
  return await ctxEval(ctx,(sel,val)=>{
    const el=document.querySelector(sel);
    if(!el) return false;
    el.focus(); el.value="";
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.value=val;
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  }, selector, value);
}

// ---------- banners / DY / CF ----------
async function dismissBanners(page){
  await page.evaluate(()=>{
    // cookie/accept/ok
    for(const b of Array.from(document.querySelectorAll("button,a,div[role='button']"))){
      if(/accept|got it|agree|allow|close|not now|ok/i.test(b.textContent||"")) b.click();
    }
    // solitics
    const x=document.querySelector("#solitics-popup-maker .solitics-close-button");
    if(x) x.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    const pop=document.getElementById("solitics-popup-maker");
    if(pop) pop.remove();

    // ---- DynamicYield hard kill ----
    for(const s of Array.from(document.querySelectorAll("#dy-global-style, .dy-common-style, style[id^='dy-'], .dy-auto-embedder"))) s.remove();
    for(const el of Array.from(document.body.children)){
      el.style.removeProperty("display");
      el.style.visibility="visible"; el.style.opacity="1";
    }

    // Welcome modal X / close
    const closes = Array.from(document.querySelectorAll("[aria-label*=close i], .close, .dy-lb-close, [data-testid='close']"));
    for(const c of closes) c.dispatchEvent(new MouseEvent("click",{bubbles:true}));
  });
  // ponekad Escape ugasi reklamu
  try{ await page.keyboard.press("Escape"); }catch{}
}

async function cfGuard(page, shots, label, retries=3){
  for(let i=0;i<retries;i++){
    const txt = await page.evaluate(()=>document.body?.innerText||"");
    const url = page.url();
    if (/challenges\.cloudflare\.com/i.test(url) ||
        /verify.*human|review the security|Please unblock challenges\.cloudflare\.com/i.test(txt)) {
      await snap(page, `${label}_cf_${i+1}`, shots, true);
      await sleep(2500);
      await page.reload({ waitUntil:"domcontentloaded", timeout:90000 }).catch(()=>{});
      await sleep(1500);
      continue;
    }
    break;
  }
}

// ---------- wait helpers ----------
async function waitForAny(page, selectors, totalMs=60000){
  const start=Date.now();
  while(Date.now()-start<totalMs){
    for(const sel of selectors){
      const el=await page.$(sel);
      if(el){
        const vis=await page.evaluate(e=>!!(e.offsetParent||(e.getClientRects&&e.getClientRects().length)), el);
        if(vis) return sel;
      }
    }
    await sleep(400);
  }
  throw new Error("none of selectors appeared: "+selectors.join(" | "));
}

// ---------- phone/country ----------
function normalizePhone(raw, defaultCc="+381"){
  if(!raw) return null;
  let s=String(raw).trim().replace(/[^\d+]/g,"");
  if(s.startsWith("+")) return s;
  if(s.startsWith("00")) return "+"+s.slice(2);
  if(s.startsWith("0")) return defaultCc + s.slice(1);
  return "+"+s;
}
function splitIntl(phone){
  const m=String(phone).match(/^\+(\d{1,4})(.*)$/);
  if(!m) return { cc:null, rest: phone.replace(/^\+/, "") };
  return { cc:`+${m[1]}`, rest: m[2].trim().replace(/\s+/g,"") };
}
async function setPhoneDialCountry(page, countryName){
  const opens=[".iti__flag-container",".vti__dropdown",".vti__selection",".phone-wrapper .dropdown",".phone-wrapper"];
  for(const sel of opens){ if(await page.$(sel)){ await clickJS(page, sel); await sleep(250); break; } }
  const picked=await page.evaluate((name)=>{
    const lists=[document.querySelector(".iti__country-list"),document.querySelector(".vti__dropdown-list"),document.querySelector(".dropdown-menu"),document.querySelector(".dropdown-list")].filter(Boolean);
    for(const list of lists){
      const items=[...list.querySelectorAll("li,div")].filter(el=>/serbia|србија/i.test(el.textContent||""));
      if(items[0]){ items[0].dispatchEvent(new MouseEvent("click",{bubbles:true})); return true; }
      const byDial=[...list.querySelectorAll("li,div")].find(el=>/\+381/.test(el.textContent||""));
      if(byDial){ byDial.dispatchEvent(new MouseEvent("click",{bubbles:true})); return true; }
    }
    return false;
  }, countryName||"Serbia");
  return picked;
}
async function typePhoneWithKeyboard(page, localDigits){
  const sels=["input[type='tel']","input[placeholder*='phone' i]","input[name*='phone' i]","#input-phone"];
  for(const sel of sels){
    if(await page.$(sel)){
      await page.click(sel,{clickCount:3});
      await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.type(sel, localDigits, {delay:25});
      await page.keyboard.press("Tab");
      return true;
    }
  }
  return false;
}

// ---------- extraction / outcome ----------
async function extractPageInfo(page){
  const text=await page.evaluate(()=>document.body?document.body.innerText:"");
  const excerpt=(text||"").replace(/\s+/g," ").slice(0,2000);
  const out={ found:false, login:null, server:null, password:null, excerpt };
  if(!text) return out;
  const login  = text.match(/(?:MT[45]\s*login|Your .* login credentials.*?Login|Login)\s*[:\-]?\s*(\d{6,12})/i);
  const server = text.match(/Server\s*[:\-]?\s*([A-Za-z0-9._\-\s]+?(?:Demo|Live)?)/i);
  const pass   = text.match(/Password\s*[:\-]?\s*([^\s\r\n]+)/i);
  if(login)  out.login=login[1];
  if(server) out.server=server[1].trim();
  if(pass)   out.password=pass[1];
  if(out.login && out.server) out.found=true;
  return out;
}
async function waitForOutcome(page, maxMs=30000){
  const start=Date.now();
  const OK=[/congratulations/i,/account application has been approved/i,/webtrader login details/i,/trade on demo/i,/login details and platforms/i,/Your Demo Account is Being Created/i];
  const ERR=[/error/i,/incorrect/i,/already used/i,/already exists/i,/try again/i,/protection/i,/blocked/i,/robot/i,/captcha/i,/not valid/i,/invalid/i];
  let last="";
  while(Date.now()-start<maxMs){
    const t=await page.evaluate(()=>document.body?document.body.innerText:"");
    last=t||"";
    if(OK.some(r=>r.test(last)))  return {status:"success", text:last.slice(0,2000)};
    if(ERR.some(r=>r.test(last))) return {status:"error",   text:last.slice(0,2000)};
    await sleep(900);
  }
  return {status:"timeout", text:last.slice(0,2000)};
}

// ---------- DEMO ----------
async function smartGotoDemo(page, shots){
  const urls=[
    "https://www.avatrade.com/demo-account",
    "https://www.avatrade.com/trading-account/demo-trading-account",
  ];
  for(const u of urls){
    log("PHASE: goto ->", u);
    await page.goto(u, { waitUntil:"domcontentloaded", timeout:90000 });
    await cfGuard(page, shots, "demo_nav");
    await dismissBanners(page);
    await snap(page,"01_goto",shots,true);

    const emailCandidates=["#input-email","input[type='email']","input[name*='mail' i]","input[placeholder*='mail' i]"];
    const passCandidates =["#input-password","input[type='password']","input[name*='pass' i]","input[placeholder*='password' i]"];
    try{
      const emailSel=await waitForAny(page, emailCandidates, 8000);
      const passSel =await waitForAny(page, passCandidates, 8000);
      return { emailSel, passSel };
    }catch{}
  }
  throw new Error("Demo form not found on known URLs");
}

app.post("/create-demo", async (req,res)=>{
  if (req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ ok:false, error:"Unauthorized" });

  const { name, email, password, phone, country="Serbia" } = req.body || {};
  if(!name || !email || !password || !phone) return res.status(400).json({ ok:false, error:"Missing fields (name, email, password, phone required)" });

  const defaultCc = country.toLowerCase().includes("serb")?"+381":"+387";
  const normPhone = normalizePhone(phone, defaultCc);
  const { rest }  = splitIntl(normPhone);

  let browser; const shots=[]; let phase="init";
  try{
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(90000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase="goto";
    const { emailSel, passSel } = await smartGotoDemo(page, shots);

    phase="fill";
    await typeJS(page, emailSel, email);
    await typeJS(page, passSel,  password);
    await setPhoneDialCountry(page, country);
    await typePhoneWithKeyboard(page, rest);
    await snap(page,"02_filled",shots);

    phase="submit";
    await page.evaluate((eSel,pSel)=>{
      const e=document.querySelector(eSel), p=document.querySelector(pSel);
      for(const el of [e,p]) if(el){
        el.dispatchEvent(new Event("input",{bubbles:true}));
        el.dispatchEvent(new Event("change",{bubbles:true}));
        el.blur();
      }
      const b=document.querySelector("button[type='submit']") || [...document.querySelectorAll("button")].find(b=>/submit|sign up|start/i.test(b.textContent||""));
      if(b) b.removeAttribute("disabled");
    }, emailSel, passSel);
    await dismissBanners(page);
    await clickJS(page, "button[type='submit']") || await clickJS(page, "button");
    await Promise.race([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:20000 }).catch(()=>{}),
      sleep(9000),
    ]);
    await snap(page,"04_after_submit",shots,true);

    // Treat "Being Created" as success to move on fast
    const textNow=await page.evaluate(()=>document.body?.innerText||"");
    const outcome = /Your Demo Account is Being Created/i.test(textNow)
      ? {status:"success", text:textNow}
      : await waitForOutcome(page, 30000);
    await snap(page,`05_outcome_${outcome.status}`,shots);

    const mt = await extractPageInfo(page);

    const baseUrl=(req.headers["x-forwarded-proto"]||req.protocol)+"://"+req.get("host");
    const screenshot_urls = shots.map(f=>`${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok: outcome.status==="success",
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

// ---------- MT4: iframe OR page fallback ----------
async function getAccountsContext(page, shots, attempts=3){
  for(let i=0;i<attempts;i++){
    // 1) try iframe
    const handle = await page.$('#my_account, iframe[src*="avacrm"]');
    if(handle){
      const frame = await handle.contentFrame();
      if(frame) return { ctx: frame, kind: "frame" };
    }

    // 2) try on page (look for "+ Add an Account" text)
    const hasAdd = await page.evaluate(()=>{
      const els=[...document.querySelectorAll("button,a,div,span")];
      return !!els.find(e=>{
        const t=(e.textContent||"").trim();
        const vis=!!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
        return vis && /\+\s*Add an Account/i.test(t);
      });
    });
    if(hasAdd) return { ctx: page, kind: "page" };

    // retry: kill overlays, reload
    await snap(page, `mt4_iframe_retry_${i+1}`, shots, true);
    await dismissBanners(page);
    try{ await page.keyboard.press("Escape"); }catch{}
    await page.reload({ waitUntil:"domcontentloaded", timeout:90000 }).catch(()=>{});
    await cfGuard(page, shots, "mt4_accounts_nav");
    await dismissBanners(page);
    await sleep(1200);
  }
  throw new Error("accounts UI not available");
}

app.post("/create-mt4", async (req,res)=>{
  if (req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ ok:false, error:"Unauthorized" });

  const { email, password } = req.body || {};
  if(!email || !password) return res.status(400).json({ ok:false, error:"Missing email/password" });

  let browser; const shots=[]; let phase="init";
  try{
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(90000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // A) login myvip (SSO)
    phase="myvip-login";
    await page.goto("https://myvip.avatrade.com/my_account", { waitUntil:"domcontentloaded", timeout:90000 });
    await cfGuard(page, shots, "mt4_myvip_nav");
    await snap(page,"mt4_00_myvip",shots,true);
    await dismissBanners(page);

    const emailSel = await waitForAny(page, ["input[type='email']","input[name='email']","#email"], 12000).catch(()=>null);
    const passSel  = await waitForAny(page, ["input[type='password']","input[name='password']","#password"], 12000).catch(()=>null);
    if(emailSel && passSel){
      await typeJS(page, emailSel, email);
      await typeJS(page, passSel,  password);
      await snap(page,"mt4_00b_myvip_filled",shots);
      await clickJS(page, "button[type='submit'], .btn, button");
      await Promise.race([
        page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:60000 }).catch(()=>{}),
        sleep(6000),
      ]);
      await snap(page,"mt4_00d_myvip_after_login",shots,true);
    }

    // B) accounts SPA
    phase="goto-accounts";
    await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil:"domcontentloaded", timeout:90000 });
    await cfGuard(page, shots, "mt4_accounts_nav");
    await dismissBanners(page);
    await snap(page,"mt4_01_accounts",shots,true);

    // C) get context (iframe OR page)
    phase="iframe";
    const { ctx, kind } = await getAccountsContext(page, shots, 3);
    await snap(page,`mt4_05_ctx_${kind}`,shots);

    // D) + Add an Account -> Demo Account -> dropdowns -> Submit
    phase="hover-add";
    const hovered = await clickByTextCtx(ctx, ["button","a","div","span"], /\+\s*Add an Account/i, true);
    await snap(page,"mt4_06_hover_add",shots);
    if(!hovered) await clickByTextCtx(ctx, ["button","a","div","span"], /\+\s*Add an Account/i, false);
    await sleep(500);

    phase="click-demo";
    await clickByTextCtx(ctx, ["button","a","div","span"], /Demo Account/i, false);
    await snap(page,"mt4_07_click_demo",shots,true);

    phase="set-dropdowns";
    await selectOptionByTextCtx(ctx, "CFD - MT4");
    await selectOptionByTextCtx(ctx, "EUR");
    await snap(page,"mt4_08_dropdowns_set",shots);

    phase="submit";
    await clickByTextCtx(ctx, ["button","a"], /^Submit$/i, false);
    await sleep(2500);
    await snap(page,"mt4_09_after_submit",shots,true);

    // E) extract login (whole page first, then ctx)
    phase="extract";
    let login = (await extractPageInfo(page)).login;
    if(!login){
      const txt = await ctxEval(ctx, ()=>document.body?.innerText || "");
      login = (txt.match(/Login\s*:\s*(\d{6,12})/i)||[])[1] || null;
    }
    await snap(page,`mt4_10_result_${login ? "ok":"miss"}`,shots,true);

    const baseUrl=(req.headers["x-forwarded-proto"]||req.protocol)+"://"+req.get("host");
    const screenshot_urls = shots.map(f=>`${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({ ok: !!login, mt4_login: login, screenshots: screenshot_urls });

  }catch(e){
    console.error("create-mt4 error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase, screenshots: [] });
  }finally{
    try{ await browser?.close(); }catch{}
  }
});

// health + static shots
app.get("/", (_req,res)=>res.send("AvaTrade Demo Service live"));
app.use("/shots", (req,res)=>{
  const filename = req.path.replace(/^\/+/, "");
  if(!/\.png$/i.test(filename)) return res.status(400).send("bad file");
  const full = path.join(process.cwd(), filename);
  if(!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

app.listen(PORT, ()=>console.log("Listening on", PORT));