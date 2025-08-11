// index.js
// Express + Puppeteer servis: AvaTrade demo signup (forma na /demo-account, bez iframe-a)

import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET || "superSecret123";
const PORT = process.env.PORT || 3000;

// ---- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function clickByTextVisible(page, selector, texts) {
  return await page.evaluate(({ selector, texts }) => {
    const tset = texts.map((t) => t.toLowerCase());
    const els = Array.from(document.querySelectorAll(selector));
    const el = els.find((e) => {
      const txt = (e.textContent || "").trim().toLowerCase();
      const vis =
        !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return vis && tset.some((t) => txt.includes(t));
    });
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, { selector, texts });
}

// Robusno biranje države u njihovom dropdownu (radi i kad nema search boxa)
async function selectCountry(page, countryName) {
  // Otvori dropdown
  await page.click(".country-wrapper .vue-country-select .dropdown", { delay: 50 }).catch(() => {});
  await sleep(400);

  // 1) Probaj search (ako postoji)
  const searchSel = ".dropdown-list input[type='search'], .dropdown-list input[role='combobox'], .dropdown-list input[aria-autocomplete='list']";
  const search = await page.$(searchSel);
  if (search) {
    await search.click({ clickCount: 3 }).catch(() => {});
    await search.type(countryName, { delay: 35 });
    await page.keyboard.press("Enter");
    return true;
  }

  // 2) Ako nema searcha – klik stavku po flag klasi ili po tekstu; skroluj listu
  // (flag za Srbiju im je .vti__flag.rs)
  const flag = await page.$("li.dropdown-item .vti__flag.rs");
  if (flag) {
    await flag.click();
    return true;
  }

  // Fallback: traži tekst "Serbia" ili "Serbia (Србија)" u <strong> unutar stavke
  const clicked = await page.evaluate((target) => {
    const term = target.toLowerCase();
    const list = document.querySelector(".dropdown-list");
    if (!list) return false;

    function visible(el) {
      return !!(el.offsetParent || (el.getClientRects && el.getClientRects().length));
    }

    // prođi više puta kroz listu uz skrol
    for (let pass = 0; pass < 40; pass++) {
      const items = Array.from(list.querySelectorAll("li.dropdown-item strong")).filter(visible);
      const match = items.find((n) => (n.textContent || "").trim().toLowerCase().includes(term));
      if (match) {
        match.click();
        return true;
      }
      list.scrollBy(0, 250);
    }
    return false;
  }, countryName);

  return clicked;
}

// Izvuci kratki tekst sa strane (za debug) i pokušaj da nađeš MT info
async function extractPageInfo(page) {
  const text = await page.evaluate(() =>
    document.body ? document.body.innerText : ""
  );
  const excerpt = (text || "").replace(/\s+/g, " ").slice(0, 1200);

  const out = { found: false, login: null, server: null, password: null, excerpt };
  if (!text) return out;

  const loginMatch = text.match(/(?:MT[45]\s*login|Account|Login)\s*[:\-]?\s*(\d{6,12})/i);
  const serverMatch = text.match(/Server\s*[:\-]?\s*([A-Za-z0-9._\-\s]+?(?:Demo|Live)?)/i);
  const passMatch = text.match(/Password\s*[:\-]?\s*([^\s\r\n]+)/i);

  if (loginMatch) out.login = loginMatch[1];
  if (serverMatch) out.server = serverMatch[1].trim();
  if (passMatch) out.password = passMatch[1];
  if (out.login && out.server) out.found = true;

  return out;
}

// ---- route ----
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, country = "Serbia" } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ ok: false, error: "Missing fields" });
  }

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    );

    // 1) Direktno na demo-formu
    await page.goto("https://www.avatrade.com/demo-account", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await sleep(1200);

    // 2) Zatvori moguće cookie/subscribe barove
    try {
      await clickByTextVisible(page, "button,a", [
        "Accept",
        "Accept All",
        "I agree",
        "Got it",
        "Not Now",
        "Close",
      ]);
    } catch {}

    // 3) Polja forme (po ID-jevima iz DOM-a)
    await page.waitForSelector("#input-email", { timeout: 25000 });
    await page.waitForSelector("#input-password", { timeout: 25000 });

    await page.click("#input-email", { clickCount: 3 });
    await page.type("#input-email", email, { delay: 30 });

    await page.click("#input-password", { clickCount: 3 });
    await page.type("#input-password", password, { delay: 30 });

    // 4) Izbor države – robustno (radi i bez search boxa)
    const selected = await selectCountry(page, country);
    if (!selected) throw new Error(`Country '${country}' not selected`);

    // 5) Sačekaj da submit postane aktivan, pa pošalji
    await page.waitForFunction(() => {
      const b = document.querySelector(
        ".submit-button button[type='submit']"
      );
      return b && !b.disabled;
    }, { timeout: 20000 });

    await page.click(".submit-button button[type='submit']");
    await sleep(7000);

    // 6) Pokušaj detekcije uspeha/MT info i kratkog teksta za debug
    const mt = await extractPageInfo(page);

    // (opciono) screenshot za Railway filesystem (možeš da skineš iz “Deployments → Files”)
    try { await page.screenshot({ path: "after_submit.png", fullPage: true }); } catch {}

    return res.json({
      ok: true,
      note: "Submit executed",
      url: page.url(),
      mt_login: mt.login,
      mt_server: mt.server,
      mt_password: mt.password || password, // često je isto, ali MT šalje svoj pass mailom
      page_excerpt: mt.excerpt,
    });
  } catch (e) {
    console.error("create-demo error:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

// healthcheck
app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));
app.listen(PORT, () => console.log("Listening on", PORT));