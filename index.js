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

// Helpers (rade i za Page i za Frame)
async function typeInto(ctx, selector, value, timeout = 25000) {
  await ctx.waitForSelector(selector, { timeout });
  const el = await ctx.$(selector);
  await el.click({ clickCount: 3 });
  await el.type(value, { delay: 30 });
}

async function clickByTextVisibleCtx(ctx, selector, texts) {
  return await ctx.evaluate(({ selector, texts }) => {
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

// Nađi frame koji sadrži email/password input
async function findAuthFrame(page, timeoutMs = 25000) {
  const emailSelectors = ["input[type='email']", "input[placeholder*='mail' i]", "input[name*='email' i]"];
  const passSelectors  = ["input[type='password']", "input[placeholder*='password' i]", "input[name*='password' i]"];

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const frames = page.frames();
    for (const f of frames) {
      const emailEl = await Promise.any(
        emailSelectors.map(sel => f.$(sel))
      ).catch(() => null);
      const passEl  = await Promise.any(
        passSelectors.map(sel => f.$(sel))
      ).catch(() => null);

      if (emailEl && passEl) return f;
    }
    await sleep(500);
  }
  throw new Error("Auth frame not found");
}

app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, country = "Serbia" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok:false, error: "Missing fields" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // 1) Idi DIREKTNO na /demo-account (stabilnije nego klik na “Free Demo”)
    await page.goto("https://www.avatrade.com/demo-account", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(1500);

    // (Ako ima cookie/subscribe bar – pokušaj zatvaranje na glavnoj stranici)
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

    // 2) Pronađi iframe koji sadrži polja
    const authFrame = await findAuthFrame(page, 30000);

    // 3) Popuni Email & Password
    await typeInto(authFrame, "input[type='email'], input[placeholder*='mail' i], input[name*='email' i]", email);
    await typeInto(authFrame, "input[type='password'], input[placeholder*='password' i], input[name*='password' i]", password);

    // 4) Country dropdown (u frame-u)
    let opened = await clickByTextVisibleCtx(authFrame, "div,span,button", ["Choose a country", "Country", "Select country"]);
    if (!opened) {
      const cInput = await authFrame.$("input[placeholder*='Country' i], input[role='combobox'], input[type='search']");
      if (cInput) await cInput.click();
    }
    await sleep(400);

    const searchBox = await authFrame.$("input[type='search'], input[role='combobox'], input[aria-autocomplete='list']");
    if (searchBox) {
      await searchBox.type(country, { delay: 35 });
      await authFrame.keyboard.press("Enter");
    } else {
      await clickByTextVisibleCtx(authFrame, "*", [country]);
    }

    // 5) Submit — “Practice For Free” (u frame-u)
    let submitClicked = await clickByTextVisibleCtx(authFrame, "button,a", ["Practice For Free", "Practice for free", "Create account", "Register"]);
    if (!submitClicked) throw new Error("Submit button not found in frame");

    // 6) Sačekaj backend (MT info scraping dodajemo kasnije)
    await sleep(7000);

    res.json({ ok: true, note: "Submit ok via iframe + /demo-account. MT info scraping TBD." });

  } catch (e) {
    console.error("create-demo error:", e?.message || e);
    res.status(500).json({ ok:false, error: String(e) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));
app.listen(PORT, () => console.log("Listening on", PORT));