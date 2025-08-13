// index.js — AvaTrade demo signup (sa telefonom, auto-detekcija prefiksa)
// - popunjava: email, password, country, phone (po potrebi samo lokalni deo)
// - čeka ishod (success/error/timeout)
// - pravi screenshotove (DEBUG_SCREENSHOTS=1) i vraća javne URL-ove

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

function ts(){ return new Date().toISOString().replace(/[:.]/g,"-").slice(0,19); }

async function snap(page, label, shots){
  if(!DEBUG) return;
  const name = `${ts()}_${label}.png`;
  try{ await page.screenshot({ path:name, fullPage:true }); shots.push(name); }catch{}
}

async function clickJS(page, selector){
  const ok = await page.evaluate((sel)=>{
    const el = document.querySelector(sel);
    if(!el) return false;
    el.scrollIntoView({block:"center", inline:"center"});
    const evts=["pointerdown","mousedown","click","pointerup","mouseup"];
    for(const t of evts) el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));
    return true;
  }, selector);
  return !!ok;
}

async function typeJS(page, selector, value){
  return await page.evaluate((sel,val)=>{
    const el = document.querySelector(sel);
    if(!el) return false;
    el.focus(); el.value=""; el.dispatchEvent(new Event("input",{bubbles:true}));
    el.value = val;
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  }, selector, value);
}

async function dismissBanners(page){
  await page.evaluate(()=>{
    const btns = Array.from(document.querySelectorAll("button,a"));
    const el = btns.find(b=>/accept|got it|agree|close|not now/i.test((b.textContent||"")));
    if(el) el.click();
  });
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

function normalizePhone(raw, defaultCc="+381"){
  if(!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g,"");
  if(s.startsWith("+")) return s;
  if(s.startsWith("00")) return "+"+s.slice(2);
  if(s.startswith?.("0")) return defaultCc + s.slice(1);
  if(s.startsWith("0")) return defaultCc + s.slice(1);
  return "+"+s;
}

function splitIntl(phone){
  const m = String(phone).match(/^\+(\d{1,4})(.*)$/);
  if(!m) return { cc:null, rest: phone.replace(/^\+/, "") };
  return { cc: `+${m[1]}`, rest: m[2].trim().replace(/\s+/g,"") };
}

async function extractPageInfo(page){
  const text = await page.evaluate(()=>document.body?document.body.innerText:"");
  const excerpt = (text||"").replace(/\s+/g," ").slice(0,2000);
  const out = { found:false, login:null, server:null, password:null, excerpt };
  if(!text) return out;
  const login  = text.match(/(?:MT[45]\s*login|Account|Login)\s*[:\-]?\s*(\d{6,12})/i);
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

async function fillPhoneSmart(page, normalizedIntl){
  // 1) pronađi input
  const phoneSelectors=["input[type='tel']","input[placeholder*='phone' i]","input[name*='phone' i]","#input-phone"];
  // 2) proveri da li UI prikazuje prefiks (+xxx) odvojeno
  const hasSeparatePrefix = await page.evaluate(()=>{
    // tražimo element sa tekstom poput “+123” u istom redu kao input
    const inp = document.querySelector("input[type='tel'],input[placeholder*='phone' i],input[name*='phone' i],#input-phone");
    if(!inp) return { found:false, code:null };
    const root = inp.closest("div") || inp.parentElement;
    if(!root) return { found:false, code:null };
    const codeEl = Array.from(root.querySelectorAll("div,span,button")).find(e=>/^\+\d{1,4}$/.test((e.textContent||"").trim()));
    return { found: !!codeEl, code: codeEl ? codeEl.textContent.trim() : null };
  });

  const { cc, rest } = splitIntl(normalizedIntl);

  // 3) upiši pravilnu vrednost
  let targetValue = normalizedIntl;         // default: ceo broj
  if(hasSeparatePrefix.found && hasSeparatePrefix.code){
    // ako UI već pokazuje npr. +381, upisujemo SAMO lokalne cifre
    // ako se razlikuje (npr. +31), i dalje upisujemo samo rest – UI vodi računa o kodu
    targetValue = rest.replace(/^\+/, "");
  }

  for(const sel of phoneSelectors){
    const ok = await typeJS(page, sel, targetValue);
    if(ok) return true;
  }
  // fallback: agresivna metoda – pokušaj na najbližem inputu uz labelu “Phone”
  await page.evaluate((value)=>{
    const txts=Array.from(document.querySelectorAll("label,div,span,p")).filter(e=>/phone/i.test(e.textContent||""));
    const inp = txts.map(t=>t.parentElement).flatMap(pe=>Array.from(pe.querySelectorAll("input")))[0];
    if(inp){
      inp.focus(); inp.value=""; inp.dispatchEvent(new Event("input",{bubbles:true}));
      inp.value=value; inp.dispatchEvent(new Event("input",{bubbles:true})); inp.dispatchEvent(new Event("change",{bubbles:true}));
    }
  }, targetValue);
  return true;
}

// ===== API =====
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, phone, country="Serbia" } = req.body || {};
  if(!name || !email || !password || !phone){
    return res.status(400).json({ ok:false, error:"Missing fields (name, email, password, phone required)" });
  }
  const defaultCc = country.toLowerCase().includes("serb")?"+381":"+387";
  const normPhone = normalizePhone(phone, defaultCc);

  let browser, phase="init";
  const shots=[];

  try{
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(45000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase="goto"; log("PHASE:", phase);
    await page.goto("https://www.avatrade.com/demo-account", { waitUntil:"networkidle2", timeout:60000 });
    await snap(page,"01_goto",shots);
    await dismissBanners(page);
    await sleep(500);

    phase="fill"; log("PHASE:", phase);
    await page.waitForSelector("#input-email");
    await page.waitForSelector("#input-password");
    await typeJS(page, "#input-email", email);
    await typeJS(page, "#input-password", password);

    // PHONE (smart)
    await fillPhoneSmart(page, normPhone);
    await snap(page,"02_filled",shots);

    phase="country"; log("PHASE:", phase);
    if(await openCountryDropdown(page)) await pickCountry(page, country);
    await snap(page,"03_country",shots);

    phase="submit"; log("PHASE:", phase);
    await page.evaluate(()=>{
      const e=document.querySelector("#input-email");
      const p=document.querySelector("#input-password");
      for(const el of [e,p]){
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
      page.waitForNavigation({ waitUntil:"networkidle2", timeout:15000 }).catch(()=>{}),
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

  }catch(e){
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase });
  }finally{
    try{ if(browser) await browser.close(); }catch{}
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