// index.js — AvaTrade flow: 1) demo-signup  2) CRM MT4 demo nalog (u iframe-u)
// DEBUG_SCREENSHOTS=1 => čuva PNG-ove i servira ih na /shots/<file>.png

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
async function snap(pageOrFrame, label, shots, full=false){
  if(!DEBUG) return;
  const name = `${ts()}_${label}.png`;
  try{
    // frame nema screenshot, pa radi uvek preko page
    const page = pageOrFrame._client ? pageOrFrame : pageOrFrame._page || pageOrFrame.mainFrame().page();
    await page.screenshot({ path:name, fullPage:!!full });
    shots.push(name);
  }catch{}
}

async function clickJS(ctx, selector){
  const ok = await ctx.evaluate((sel)=>{
    const el = document.querySelector(sel);
    if(!el) return false;
    el.scrollIntoView({block:"center", inline:"center"});
    const evts=["pointerover","mouseover","pointerdown","mousedown","click","pointerup","mouseup"];
    for(const t of evts) el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window}));
    return true;
  }, selector);
  return !!ok;
}
async function typeJS(ctx, selector, value){
  return await ctx.evaluate((sel,val)=>{
    const el = document.querySelector(sel);
    if(!el) return false;
    el.focus(); el.value=""; el.dispatchEvent(new Event("input",{bubbles:true}));
    el.value = val;
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return true;
  }, selector, value);
}

async function dismissBanners(ctx){
  await ctx.evaluate(()=>{
    const btns = Array.from(document.querySelectorAll("button,a,div[role='button'],.solitics-close-button"));
    const el = btns.find(b=>/accept|got it|agree|close|ok|not now|×/i.test((b.textContent||"")));
    if(el) el.click();
  });
}

async function extractText(ctx){
  return await ctx.evaluate(()=>document.body?document.body.innerText:"");
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
      const isMac = await page.evaluate(()=>navigator.platform.includes("Mac"));
      if(isMac){ await page.keyboard.down("Meta"); } else { await page.keyboard.down("Control"); }
      await page.keyboard.press("KeyA");
      if(isMac){ await page.keyboard.up("Meta"); } else { await page.keyboard.up("Control"); }
      await page.keyboard.press("Backspace");
      await page.type(sel, localDigits, { delay: 30 });
      await page.keyboard.press("Tab");
      return true;
    }
  }
  return false;
}

async function extractMT4From(ctx){
  const text = await extractText(ctx);
  const login = (text.match(/Login\s*:\s*(\d{6,12})/i)||[])[1] || null;
  const server = (text.match(/Server\s*:\s*([A-Za-z0-9.\-\s]+?)(?:\r?\n|$)/i)||[])[1] || null;
  return { login, server, raw: text.slice(0,2000) };
}

// ========== 1) /create-demo ==========
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, phone, country="Serbia" } = req.body || {};
  if(!name || !email || !password || !phone){
    return res.status(400).json({ ok:false, error:"Missing fields (name, email, password, phone required)" });
  }
  const normPhone = normalizePhone(phone, country.toLowerCase().includes("serb")?"+381":"+387");
  const { rest } = splitIntl(normPhone);

  let browser, phase="init";
  const shots=[];

  try{
    browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setCacheEnabled(false);
    await page.setDefaultTimeout(45000);
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    phase="goto"; log("PHASE:", phase);
    await page.goto("https://www.avatrade.com/demo-account", { waitUntil:"domcontentloaded", timeout:60000 });
    await snap(page,"01_goto",shots,true);
    await dismissBanners(page);
    await sleep(400);

    phase="fill";
    await page.waitForSelector("#input-email");
    await page.waitForSelector("#input-password");
    await typeJS(page, "#input-email", email);
    await typeJS(page, "#input-password", password);

    await setPhoneDialCountry(page, country);
    await typePhoneWithKeyboard(page, rest);
    await snap(page,"02_filled",shots);

    phase="country";
    if(await openCountryDropdown(page)) await pickCountry(page, country);
    await snap(page,"03_country",shots);

    phase="submit";
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
    await sleep(300);
    await page.evaluate(()=>{ const b=document.querySelector("button[type='submit']"); if(b) b.removeAttribute("disabled"); });
    await clickJS(page, "button[type='submit']");
    await Promise.race([
      page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:15000 }).catch(()=>{}),
      sleep(8000)
    ]);
    await snap(page,"04_after_submit",shots);

    const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok: true,
      note: "Submitted signup (captcha/protection may still appear)",
      url: page.url(),
      screenshots: screenshot_urls
    });

  }catch(e){
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok:false, error:String(e), phase });
  }finally{
    try{ if(browser) await browser.close(); }catch{}
  }
});

// ========== 2) /create-mt4 — U IFRAME-U ==========
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

    // 1) Accounts (možda traži login)
    phase="goto-accounts"; log("PHASE:", phase);
    await page.goto("https://webtrader7.avatrade.com/crm/accounts", { waitUntil:"domcontentloaded", timeout:60000 });
    await snap(page,"mt4_01_accounts",shots);

    // Ako postoji login forma bilo gde (i u iframe-ovima), popuni je
    async function tryLoginInAllFrames() {
      const frames = page.frames();
      for (const fr of [page.mainFrame(), ...frames]) {
        const hasEmail = await fr.$("input[type='email'], input[name='email']");
        const hasPass  = await fr.$("input[type='password'], input[name='password']");
        if (hasEmail && hasPass) {
          await typeJS(fr, "input[type='email'], input[name='email']", email);
          await typeJS(fr, "input[type='password'], input[name='password']", password);
          await fr.evaluate(()=>{
            const btn = Array.from(document.querySelectorAll("button, a, div[role='button']"))
              .find(b => /login|sign in/i.test(b.textContent||""));
            if(btn) btn.dispatchEvent(new MouseEvent("click",{bubbles:true}));
          });
          await Promise.race([
            page.waitForNavigation({ waitUntil:"domcontentloaded", timeout:20000 }).catch(()=>{}),
            sleep(6000)
          ]);
          await snap(page,"mt4_02_after_login",shots);
          return true;
        }
      }
      return false;
    }
    await tryLoginInAllFrames().catch(()=>{});

    // 2) Uđi u iframe #my_account
    phase="iframe"; log("PHASE:", phase);
    const frameEl = await page.waitForSelector("#my_account", { timeout: 30000 });
    const frame   = await frameEl.contentFrame();
    await dismissBanners(frame);
    await snap(page,"mt4_03_iframe_ready",shots);

    // 3) Hover "+ Add an Account" (u IFRAME-u), pa klik "Demo Account"
    phase="add-account"; log("PHASE:", phase);
    // Fizički hover mišem (računa box iframe-a + box dugmeta)
    const addBox = await frame.evaluate(() => {
      const cands = Array.from(document.querySelectorAll("button, a, div[role='button']"));
      const btn = cands.find(b => /\+\s*add an account/i.test((b.textContent||"")));
      if(!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2 };
    });
    if (!addBox) throw new Error("Add an Account button not found in iframe");

    const iframeBox = await frameEl.boundingBox();
    await page.mouse.move(iframeBox.x + addBox.x, iframeBox.y + addBox.y);
    await sleep(700); // hover → pojavi se "Demo Account"
    await snap(page,"mt4_04_hover_add",shots);

    // Klikni "Demo Account" (element ispod)
    await frame.evaluate(()=>{
      const el = Array.from(document.querySelectorAll("button, a, div, span"))
        .find(e => /demo account/i.test((e.textContent||"")));
      if(el) el.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    });
    await Promise.race([
      frame.waitForSelector("button, a", {timeout:15000}).catch(()=>{}),
      sleep(1200)
    ]);
    await snap(page,"mt4_05_clicked_demo",shots);

    // 4) Forma: CFD - MT4 i EUR (radi za <select> i custom dropdown)
    phase="form"; log("PHASE:", phase);
    await dismissBanners(frame);
    await sleep(500);

    // probaj kao <select>
    const hasSelects = await frame.$$("select");
    if (hasSelects && hasSelects.length >= 2) {
      await frame.select("select", ...(await frame.$$eval("select", sels=>{
        // pickuje vrednosti za "CFD - MT4" i "EUR"
        const vals=[];
        const pick=(sel, rx)=>{
          const opt=[...sel.options].find(o=>rx.test(o.textContent||""));
          if(opt) vals.push(opt.value);
        };
        if(sels[0]) pick(sels[0], /CFD\s*-\s*MT4/i);
        if(sels[1]) pick(sels[1], /^EUR$/i);
        return vals;
      })));
      // osveži evente
      await frame.evaluate(()=>{
        document.querySelectorAll("select").forEach(s=>s.dispatchEvent(new Event("change",{bubbles:true})));
      });
    } else {
      // custom dropdown: prvo (platforma)
      await frame.evaluate(()=>{
        function openNth(n){
          const dds = Array.from(document.querySelectorAll("div[role='combobox'], .dropdown, .Select__control, .select"));
          const el = dds[n]; if(el) el.dispatchEvent(new MouseEvent("click",{bubbles:true}));
        }
        function clickText(rex){
          const el = Array.from(document.querySelectorAll("li,div,span,a"))
            .find(e=>rex.test((e.textContent||"").trim()));
          if(el) el.dispatchEvent(new MouseEvent("click",{bubbles:true}));
        }
        openNth(0); clickText(/CFD\s*-\s*MT4/i);
        openNth(1); clickText(/^EUR$/i);
      });
    }
    await snap(page,"mt4_06_options_set",shots);

    // 5) Submit (zeleno dugme)
    phase="submit"; log("PHASE:", phase);
    await frame.evaluate(()=>{
      const btn = Array.from(document.querySelectorAll("button, a")).find(b=>/submit/i.test(b.textContent||""));
      if(btn) btn.dispatchEvent(new MouseEvent("click",{bubbles:true}));
    });
    await Promise.race([
      sleep(8000),
      frame.waitForFunction(()=>/Thank you for your registration/i.test(document.body.innerText), {timeout:25000}).catch(()=>{})
    ]);
    await snap(page,"mt4_07_after_submit",shots,true);

    // 6) Izvuci Login i Server sa success ekrana
    phase="extract"; log("PHASE:", phase);
    const info = await extractMT4From(frame);
    const ok = !!info.login;

    const baseUrl = (req.headers["x-forwarded-proto"] || req.protocol) + "://" + req.get("host");
    const screenshot_urls = shots.map(f => `${baseUrl}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok,
      note: ok ? "MT4 created" : "Could not parse login",
      url: page.url(),
      mt4_login: info.login || null,
      mt4_server: info.server || null,
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
  if(!/\.png$/i.test(filename)) return res.status(400).send("bad file");
  const full = path.join(process.cwd(), filename);
  if(!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

app.listen(PORT, ()=>console.log("Listening on", PORT));