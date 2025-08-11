import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

const SHARED_SECRET = process.env.PUPPETEER_SHARED_SECRET;
const PORT = process.env.PORT || 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ---- FRAME HELPERS ----
async function findAuthFrame(page, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  const emailSel = "input[type='email'], input[placeholder*='mail' i], input[name*='email' i]";
  const passSel  = "input[type='password'], input[placeholder*='password' i], input[name*='password' i]";

  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try {
        const e = await f.$(emailSel);
        const p = await f.$(passSel);
        if (e && p) return f;
      } catch { /* frame maybe detaching, ignore */ }
    }
    await sleep(300);
  }
  throw new Error("Auth frame not found");
}

async function withAuthFrame(page, fn, retries = 3) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const f = await findAuthFrame(page, 30000);
      return await fn(f);
    } catch (e) {
      lastErr = e;
      // Ako je “detached frame” ili “Execution context was destroyed” – probaj ponovo
      if (!String(e).toLowerCase().includes("detached") &&
          !String(e).toLowerCase().includes("execution context was destroyed")) {
        break;
      }
      await sleep(500);
    }
  }
  throw lastErr;
}

async function typeIntoFrame(frame, selector, value) {
  await frame.waitForSelector(selector, { timeout: 25000 });
  const el = await frame.$(selector);
  await el.click({ clickCount: 3 });
  await el.type(value, { delay: 30 });
}

async function clickByTextVisibleCtx(frame, selector, texts) {
  return await frame.evaluate(({ selector, texts }) => {
    const tset = texts.map(t => t.toLowerCase());
    const els = Array.from(document.querySelectorAll(selector));
    const el = els.find(e => {
      const txt = (e.textContent || "").trim().toLowerCase();
      const vis = !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
      return vis && tset.some(t => txt.includes(t));
    });
    if (el) { el.click(); return true; }
    return false;
  }, { selector, texts });
}

// ---- ROUTE ----
app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, country = "Serbia" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok:false, error: "Missing fields" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // 1) DIREKTAN URL za demo (stabilnije)
    await page.goto("https://www.avatrade.com/demo-account", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);

    // (Opcionalno) zatvori cookie/subscribe na parent strani
    try {
      await page.evaluate(() => {
        const tryClick = (texts) => {
          const tset = texts.map(t => t.toLowerCase());
          const els = Array.from(document.querySelectorAll("button,a"));
          const el = els.find(e => {
            const txt = (e.textContent || "").toLowerCase();
            const vis = !!(e.offsetParent || (e.getClientRects && e.getClientRects().length));
            return vis && tset.some(t => txt.includes(t));
          });
          if (el) el.click();
        };
        tryClick(["Accept", "Accept All", "I agree", "Not Now", "Close", "Got it"]);
      });
    } catch {}

    // 2) Email + Password (uvek prvo pronađi svež frame)
    const emailSel = "input[type='email'], input[placeholder*='mail' i], input[name*='email' i]";
    const passSel  = "input[type='password'], input[placeholder*='password' i], input[name*='password' i]";

    await withAuthFrame(page, async (f) => {
      await typeIntoFrame(f, emailSel, email);
      await typeIntoFrame(f, passSel, password);
    });

    // 3) Country dropdown + izbor
    await withAuthFrame(page, async (f) => {
      let opened = await clickByTextVisibleCtx(f, "div,span,button", ["Choose a country", "Country", "Select country"]);
      if (!opened) {
        const cInput = await f.$("input[placeholder*='Country' i], input[role='combobox'], input[type='search']");
        if (cInput) await cInput.click();
      }
      await sleep(400);

      const searchBox = await f.$("input[type='search'], input[role='combobox'], input[aria-autocomplete='list']");
      if (searchBox) {
        await searchBox.type(country, { delay: 35 });
        await f.keyboard.press("Enter");
      } else {
        await clickByTextVisibleCtx(f, "*", [country]);
      }
    });

    // 4) Submit
    await withAuthFrame(page, async (f) => {
      let submitClicked = await clickByTextVisibleCtx(f, "button,a", ["Practice For Free", "Practice for free", "Create account", "Register"]);
      if (!submitClicked) throw new Error("Submit button not found in frame");
    });

    // 5) Sačekaj backend – (MT info scraping dodajemo posle)
    await sleep(7000);

    res.json({ ok: true, note: "Submit ok via iframe with re-acquire. MT info scraping TBD." });

  } catch (e) {
    console.error("create-demo error:", e?.message || e);
    res.status(500).json({ ok:false, error: String(e) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));
app.listen(PORT, () => console.log("Listening on", PORT));