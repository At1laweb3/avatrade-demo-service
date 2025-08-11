import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET;
const PORT = process.env.PORT || 3000;

function checkAuth(req, res, next) {
  if (req.headers["x-auth"] !== SHARED_SECRET) return res.status(401).json({ error: "Unauthorized" });
  next();
}

async function launchBrowser() {
  return await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1366, height: 900 }
  });
}

// helpers (bez XPath-a)
async function clickByTextVisible(page, selector, texts) {
  return await page.evaluate(({ selector, texts }) => {
    const tset = texts.map(t => t.toLowerCase());
    const els = Array.from(document.querySelectorAll(selector));
    const el = els.find(e => {
      const txt = (e.textContent || "").trim().toLowerCase();
      const visible = !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return visible && tset.some(t => txt.includes(t));
    });
    if (el) { el.click(); return true; }
    return false;
  }, { selector, texts });
}

async function typeInto(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 25000 });
  const el = await page.$(selector);
  await el.click({ clickCount: 3 });
  await el.type(value, { delay: 30 });
}

app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, country = "Serbia" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok:false, error: "Missing fields" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // 1) open home (čekamo malo duže da se učita header)
    await page.goto("https://www.avatrade.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);

    // 2) cookie/subscribe bar
    try {
      let ok = await clickByTextVisible(page, "button,a", ["Accept", "Accept All", "I agree", "Got it"]);
      if (!ok) ok = await clickByTextVisible(page, "button,a", ["Not Now", "Close"]);
    } catch {}

    // 3) pokušaj 1: klik po tekstu “Free Demo”
    let clicked = await clickByTextVisible(page, "a,button,div,span", [
      "Free Demo", "Free demo", "FREE DEMO", "Free Demo Account", "Demo account"
    ]);

    // 3b) pokušaj 2: po href-u (link koji sadrži 'demo')
    if (!clicked) {
      clicked = await page.evaluate(() => {
        const all = Array.from(document.querySelectorAll("a,button"));
        const el = all.find(e => {
          const href = (e.getAttribute("href") || "").toLowerCase();
          const txt = (e.textContent || "").toLowerCase();
          const vis = !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
          return vis && (href.includes("demo") || txt.includes("demo"));
        });
        if (el) { el.click(); return true; }
        return false;
      });
    }

    if (!clicked) {
      await page.screenshot({ path: "debug_no_demo.png", fullPage: true });
      throw new Error("Free Demo button not found");
    }

    // 4) čekaj da se modal pojavi i polja budu spremna
    // probamo najpre po placeholder-ima, zatim fallback na tip/name
    await page.waitForTimeout(600);
    const emailSel = "input[placeholder='Email'], input[type='email'], input[name*='email' i]";
    const passSel  = "input[placeholder='Password'], input[type='password'], input[name*='password' i]";

    await typeInto(page, emailSel, email);
    await typeInto(page, passSel, password);

    // 5) country dropdown
    let opened = await clickByTextVisible(page, "div,span,button", ["Choose a country", "Country", "Select country"]);
    if (!opened) {
      const cInput = await page.$("input[placeholder*='Country' i], input[role='combobox'], input[type='search']");
      if (cInput) await cInput.click();
    }
    await page.waitForTimeout(400);

    const searchBox = await page.$("input[type='search'], input[role='combobox'], input[aria-autocomplete='list']");
    if (searchBox) {
      await searchBox.type(country, { delay: 35 });
      await page.keyboard.press("Enter");
    } else {
      // fallback: pokušaj direktan klik na item sa imenom države
      await clickByTextVisible(page, "*", [country]);
    }

    // 6) submit
    let submitClicked = await clickByTextVisible(page, "button,a", ["Practice For Free", "Practice for free", "Create account", "Register"]);
    if (!submitClicked) {
      await page.screenshot({ path: "debug_no_submit.png", fullPage: true });
      throw new Error("Submit button not found");
    }

    // 7) pričekaj da server obradi (kasnije dodajemo MT info scraping)
    await page.waitForTimeout(7000);
    res.json({ ok: true, note: "Submit ok. MT info scraping TBD." });

  } catch (e) {
    console.error("create-demo error:", e?.message || e);
    res.status(500).json({ ok:false, error: String(e) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));
app.listen(PORT, () => console.log("Listening on", PORT));