// index.js — AvaTrade automation service
// Endpoints:
//   POST /create-demo   -> napravi demo na avatrade.com (traži: name, email, password, phone, country?)
//   POST /create-mt4    -> uloguj se u CRM i kreiraj MT4 demo (traži: email, password)
//
// Radi i u headless okruženju (Railway). Ako DEBUG_SCREENSHOTS=1 snima PNG u / (root).

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

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
async function snap(page, label, shots, full = false) {
  if (!DEBUG) return;
  const name = `${ts()}_${label}.png`;
  try {
    await page.screenshot({ path: name, fullPage: !!full });
    shots.push(name);
  } catch {}
}
function baseUrlFrom(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${proto}://${req.get("host")}`;
}

function checkAuth(req, res, next) {
  if (req.headers["x-auth"] !== SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

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

async function dismissBanners(page) {
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("button,a,div"));
    const hit = els.find((e) =>
      /accept|agree|got it|close|ok|not now/i.test(e.textContent || "")
    );
    if (hit) hit.click();
  });
}
async function clickJS(page, selector) {
  const ok = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "center" });
    const evs = ["pointerdown", "mousedown", "click", "pointerup", "mouseup"];
    for (const t of evs)
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    return true;
  }, selector);
  return !!ok;
}
async function typeJS(page, selector, value) {
  return await page.evaluate(
    (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.focus();
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.value = val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    selector,
    value
  );
}
async function clickByText(page, tagSel, regex) {
  return await page.evaluate(
    (tagSel, reSource, reFlags) => {
      const re = new RegExp(reSource, reFlags);
      const els = Array.from(document.querySelectorAll(tagSel));
      const el = els.find(
        (e) => e && re.test((e.textContent || "").trim())
      );
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    },
    tagSel,
    regex.source,
    regex.flags
  );
}

// ---------- helpers za country/phone (demo signup) ----------
function normalizePhone(raw, defaultCc = "+381") {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[^\d+]/g, "");
  if (s.startsWith("+")) return s;
  if (s.startsWith("00")) return "+" + s.slice(2);
  if (s.startsWith("0")) return defaultCc + s.slice(1);
  return "+" + s;
}
function splitIntl(phone) {
  const m = String(phone).match(/^\+(\d{1,4})(.*)$/);
  if (!m) return { cc: null, rest: phone.replace(/^\+/, "") };
  return { cc: `+${m[1]}`, rest: m[2].trim().replace(/\s+/g, "") };
}
async function openCountryDropdown(page) {
  const tries = [
    ".country-wrapper .vue-country-select .dropdown",
    ".country-wrapper .vue-country-select",
    "input[placeholder='Choose a country']",
    ".country-wrapper .selected-flag",
    ".country-wrapper",
  ];
  for (const sel of tries) {
    if (await clickJS(page, sel)) {
      await sleep(400);
      if (await page.$(".dropdown-list")) return true;
    }
  }
  await page.evaluate(() => {
    const hits = ["choose a country", "country", "select country"];
    const els = Array.from(document.querySelectorAll("button,div,span,input"));
    const el = els.find((e) => {
      const t = ((e.textContent || e.placeholder || "") + "").toLowerCase();
      const vis =
        !!e.offsetParent || (e.getClientRects && e.getClientRects().length);
      return vis && hits.some((h) => t.includes(h));
    });
    if (el) el.click();
  });
  await sleep(400);
  return !!(await page.$(".dropdown-list"));
}
async function pickCountry(page, countryName) {
  const searchSel =
    ".dropdown-list input[type='search'], .dropdown-list input[role='combobox'], .dropdown-list input[aria-autocomplete='list']";
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
    function vis(el) {
      return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length));
    }
    for (let p = 0; p < 80; p++) {
      const items = Array.from(
        list.querySelectorAll("li.dropdown-item, li, div.dropdown-item")
      ).filter(vis);
      const target = items.find((it) => {
        const txt = (it.textContent || "").trim().toLowerCase();
        return names.some((n) => txt.includes(n.toLowerCase()));
      });
      if (target) {
        target.click();
        return true;
      }
      list.scrollBy(0, 260);
    }
    return false;
  }, names);
  return !!ok;
}
async function setPhoneDialCountry(page, countryName) {
  const openTries = [
    ".iti__flag-container",
    ".vti__dropdown",
    ".vti__selection",
    ".phone-wrapper .dropdown",
    ".phone-wrapper",
  ];
  for (const sel of openTries) {
    if (await page.$(sel)) {
      await clickJS(page, sel);
      await sleep(300);
      break;
    }
  }
  const picked = await page.evaluate((name) => {
    const lists = [
      document.querySelector(".iti__country-list"),
      document.querySelector(".vti__dropdown-list"),
      document.querySelector(".dropdown-menu"),
      document.querySelector(".dropdown-list"),
    ].filter(Boolean);
    for (const list of lists) {
      const items = Array.from(list.querySelectorAll("li,div")).filter((el) =>
        /serbia|србија/i.test(el.textContent || "")
      );
      if (items[0]) {
        items[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      }
      const byDial = Array.from(list.querySelectorAll("li,div")).find((el) =>
        /\+381/.test(el.textContent || "")
      );
      if (byDial) {
        byDial.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      }
    }
    return false;
  }, countryName || "Serbia");
  return picked;
}
async function typePhoneWithKeyboard(page, localDigits) {
  const sels = [
    "input[type='tel']",
    "input[placeholder*='phone' i]",
    "input[name*='phone' i]",
    "#input-phone",
  ];
  for (const sel of sels) {
    if (await page.$(sel)) {
      await page.click(sel, { clickCount: 3 });
      const isMac = await page.evaluate(() =>
        (navigator.platform || "").includes("Mac")
      );
      if (isMac) await page.keyboard.down("Meta");
      else await page.keyboard.down("Control");
      await page.keyboard.press("KeyA");
      if (isMac) await page.keyboard.up("Meta");
      else await page.keyboard.up("Control");
      await page.keyboard.press("Backspace");
      await page.type(sel, localDigits, { delay: 30 });
      await page.keyboard.press("Tab");
      return true;
    }
  }
  return false;
}
async function extractPageInfo(page) {
  const text = await page.evaluate(() =>
    document.body ? document.body.innerText : ""
  );
  const excerpt = (text || "").replace(/\s+/g, " ").slice(0, 2000);
  const out = { found: false, login: null, server: null, password: null, excerpt };
  if (!text) return out;

  const loginMatch = text.match(/(?:MT[45]\s*login|Login)\s*[:\-]?\s*(\d{6,12})/i);
  const serverMatch = text.match(
    /Server\s*[:\-]?\s*([A-Za-z0-9._\-\s]+?(?:Demo|Live)?)/i
  );
  const passMatch = text.match(/Password\s*[:\-]?\s*([^\s\r\n]+)/i);

  if (loginMatch) out.login = loginMatch[1];
  if (serverMatch) out.server = serverMatch[1].trim();
  if (passMatch) out.password = passMatch[1];
  if (out.login && out.server) out.found = true;
  return out;
}
async function waitForOutcome(page, maxMs = 60000) {
  const start = Date.now();
  const SUCCESS = [
    /congratulations/i,
    /account application has been approved/i,
    /webtrader login details/i,
    /trade on demo/i,
    /login details and platforms/i,
    /your demo account is ready/i,
  ];
  const ERROR = [
    /error/i,
    /incorrect/i,
    /already used/i,
    /already exists/i,
    /try again/i,
    /protection/i,
    /blocked/i,
    /robot/i,
    /captcha/i,
    /not valid/i,
    /invalid/i,
  ];
  let lastText = "";

  while (Date.now() - start < maxMs) {
    const text = await page.evaluate(() =>
      document.body ? document.body.innerText : ""
    );
    lastText = text || "";
    if (SUCCESS.some((r) => r.test(lastText)))
      return { status: "success", text: lastText.slice(0, 2000) };
    if (ERROR.some((r) => r.test(lastText)))
      return { status: "error", text: lastText.slice(0, 2000) };
    await sleep(1200);
  }
  return { status: "timeout", text: lastText.slice(0, 2000) };
}

// ------------- DEMO SIGNUP -------------
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, phone, country = "Serbia" } = req.body || {};
  if (!name || !email || !password || !phone) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing fields (name,email,password,phone)" });
  }

  const defaultCc = country.toLowerCase().includes("serb") ? "+381" : "+387";
  const normPhone = normalizePhone(phone, defaultCc);
  const { rest } = splitIntl(normPhone);

  let browser;
  const shots = [];
  let phase = "init";

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // Manji footprint
    await page.setCacheEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (rq) => {
      const u = rq.url();
      const t = rq.resourceType();
      if (
        t === "media" ||
        t === "font" ||
        t === "manifest" ||
        /googletagmanager|google-analytics|doubleclick|facebook|hotjar|segment|optimizely/i.test(
          u
        )
      ) {
        rq.abort();
      } else rq.continue();
    });

    await page.setDefaultTimeout(45000);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    );

    phase = "goto";
    log("PHASE:", phase);
    await page.goto("https://www.avatrade.com/demo-account", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await snap(page, "01_goto", shots, true);
    await dismissBanners(page);
    await sleep(400);

    phase = "fill";
    log("PHASE:", phase);
    await page.waitForSelector("#input-email");
    await page.waitForSelector("#input-password");
    await typeJS(page, "#input-email", email);
    await typeJS(page, "#input-password", password);

    await setPhoneDialCountry(page, country);
    await typePhoneWithKeyboard(page, rest);
    await snap(page, "02_filled", shots);

    phase = "country";
    log("PHASE:", phase);
    if (await openCountryDropdown(page)) await pickCountry(page, country);
    await snap(page, "03_country", shots);

    phase = "submit";
    log("PHASE:", phase);
    await page.evaluate(() => {
      const e = document.querySelector("#input-email");
      const p = document.querySelector("#input-password");
      for (const el of [e, p]) {
        if (!el) continue;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.blur();
      }
    });
    await dismissBanners(page);
    await sleep(350);
    await page.evaluate(() => {
      const b = document.querySelector("button[type='submit']");
      if (b) b.removeAttribute("disabled");
    });
    await clickJS(page, "button[type='submit']");
    await Promise.race([
      page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
        .catch(() => {}),
      sleep(8000),
    ]);
    await snap(page, "04_after_submit", shots);

    phase = "outcome";
    log("PHASE:", phase);
    const outcome = await waitForOutcome(page, 60000);
    await snap(page, `05_outcome_${outcome.status}`, shots);

    phase = "extract";
    log("PHASE:", phase);
    const mt = await extractPageInfo(page);

    const base = baseUrlFrom(req);
    const screenshot_urls = shots.map((f) => `${base}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok: outcome.status === "success",
      note: `Outcome: ${outcome.status}`,
      url: page.url(),
      outcome_excerpt: outcome.text?.slice(0, 500) || "",
      mt_login: mt.login,
      mt_server: mt.server,
      mt_password: mt.password || password,
      page_excerpt: mt.excerpt,
      phone_used: normPhone,
      screenshots: screenshot_urls,
    });
  } catch (e) {
    console.error("create-demo error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok: false, error: String(e), phase });
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
  }
});

// ------------- MT4 U CRM-U -------------
async function loginCRM(page, email, password) {
  await page.goto("https://webtrader7.avatrade.com/crm/accounts", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Ako smo već ulogovani – pojavi se "+ Add an Account"
  const addBtn = await page.$x("//button[contains(., '+ Add an Account')]");
  if (addBtn && addBtn.length) return true;

  // Inače popuni login formu
  await page.waitForTimeout(800);
  const emailSel =
    "input[type='email'], input[name*='email' i], input#email, input#Email";
  const passSel =
    "input[type='password'], input[name*='password' i], input#password, input#Password";

  if (await page.$(emailSel)) await typeJS(page, emailSel, email);
  if (await page.$(passSel)) await typeJS(page, passSel, password);

  // dugme za login
  const clicked =
    (await clickByText(page, "button, a", /log\s*in|sign\s*in/i)) ||
    (await clickJS(page, "button[type='submit']"));
  if (!clicked) {
    // fallback – Enter
    await page.keyboard.press("Enter");
  }

  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {});
  // čekaj da se pojavi Add an Account
  for (let i = 0; i < 20; i++) {
    const ok = await page.$x("//button[contains(., '+ Add an Account')]");
    if (ok && ok.length) return true;
    await sleep(500);
  }
  return false;
}

async function createMT4(page, shots) {
  // otvori dropdown iz + Add an Account i klikni "Demo Account"
  const addClicked =
    (await clickByText(page, "button", /\+?\s*add an account/i)) ||
    (await clickJS(page, "button.btn.btn-success")) ||
    (await clickJS(page, "[data-testid='add-account']"));
  await sleep(300);

  // Ako ima dropdown, klikni Demo Account
  const demoClicked =
    (await clickByText(page, "button, a, div", /demo\s*account/i)) ||
    (await clickByText(page, "a", /add demo account/i));
  await sleep(600);

  // Sada bi trebalo da smo na formi "Add Demo Account"
  await snap(page, "mt4_01_add_form", shots);

  // Izaberi "CFD - MT4"
  await page.evaluate(() => {
    function choose(selectEl, matchRe) {
      if (!selectEl) return false;
      const opts = Array.from(selectEl.options);
      const hit = opts.find((o) => matchRe.test((o.text || "").trim()));
      if (hit) {
        selectEl.value = hit.value;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }
    const selects = Array.from(document.querySelectorAll("select"));
    const byLabel = (txt) => {
      const lbl = Array.from(document.querySelectorAll("label")).find((l) =>
        new RegExp(txt, "i").test(l.textContent || "")
      );
      if (!lbl) return null;
      const forId = lbl.getAttribute("for");
      if (forId) return document.getElementById(forId);
      // probaj najbliži select
      const sel = lbl.parentElement?.querySelector("select");
      return sel || null;
    };

    const platSel =
      byLabel("Trading Platform") || selects.find((s) => /platform/i.test(s.name || ""));
    choose(platSel, /mt4/i);

    const currSel =
      byLabel("Base Currency") || selects.find((s) => /currency/i.test(s.name || ""));
    choose(currSel, /^eur$/i);
  });

  await snap(page, "mt4_02_selected", shots);

  // Submit
  const submitted =
    (await clickByText(page, "button", /^submit$/i)) ||
    (await clickJS(page, "button[type='submit']"));
  if (!submitted) throw new Error("Submit button not found");
  await Promise.race([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => {}),
    sleep(4000),
  ]);

  // Sačekaj tekst "Your Demo Account is Ready!"
  const outcome = await waitForOutcome(page, 60000);
  await snap(page, `mt4_03_outcome_${outcome.status}`, shots);

  // Parsiraj login/server
  const mt = await extractPageInfo(page);
  return { outcome, mt };
}

app.post("/create-mt4", checkAuth, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, error: "Missing email/password" });
  }

  let browser;
  const shots = [];
  let phase = "init";

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setDefaultTimeout(60000);

    phase = "login";
    log("PHASE:", phase);
    const okLogin = await loginCRM(page, email, password);
    await snap(page, "mt4_login_after", shots);
    if (!okLogin) throw new Error("CRM login failed");

    phase = "add-mt4";
    log("PHASE:", phase);
    const { outcome, mt } = await createMT4(page, shots);

    const base = baseUrlFrom(req);
    const screenshot_urls = shots.map((f) => `${base}/shots/${encodeURIComponent(f)}`);

    return res.json({
      ok: outcome.status === "success" && !!mt.login,
      note: `Outcome: ${outcome.status}`,
      url: page.url(),
      outcome_excerpt: outcome.text?.slice(0, 500) || "",
      mt_login: mt.login,
      mt_server: mt.server,
      screenshots: screenshot_urls,
    });
  } catch (e) {
    console.error("create-mt4 error:", e?.message || e, "AT PHASE:", phase);
    return res.status(500).json({ ok: false, error: String(e), phase });
  } finally {
    try {
      if (browser) await browser.close();
    } catch {}
  }
});

// health + serving screenshots
app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));
app.use("/shots", (req, res) => {
  const filename = req.path.replace(/^\/+/, "");
  if (!/\.png$/i.test(filename)) return res.status(400).send("bad file");
  const full = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(full)) return res.status(404).send("not found");
  res.sendFile(full);
});

app.listen(PORT, () => console.log("Listening on", PORT));