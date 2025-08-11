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

// Pom. funkcije bez XPath-a
async function clickByText(page, selectors, text) {
  // Klikne prvi element čiji text sadrži `text` (case-insensitive)
  return await page.$$eval(selectors, (els, t) => {
    const needle = t.toLowerCase();
    const el = els.find(e => (e.textContent || "").toLowerCase().includes(needle));
    if (el) { el.click(); return true; }
    return false;
  }, text);
}

async function typeInto(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 20000 });
  const el = await page.$(selector);
  await el.click({ clickCount: 3 });
  await el.type(value, { delay: 35 });
}

async function launchBrowser() {
  return await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1280, height: 900 }
  });
}

app.post("/create-demo", checkAuth, async (req, res) => {
  const { name, email, password, country = "Serbia" } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: "Missing fields" });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36");

    // 1) Home
    await page.goto("https://www.avatrade.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

    // 2) Cookies (ako postoji)
    try {
      await page.waitForTimeout(800);
      // Pokušaj klik na dugme koje sadrži 'Accept' ili 'I agree'
      let clicked = await clickByText(page, "button,a", "Accept");
      if (!clicked) clicked = await clickByText(page, "button,a", "I agree");
    } catch {}

    // 3) "Free Demo" (modal na istoj strani)
    const clickedDemo = await clickByText(page, "a,button", "Free Demo");
    if (!clickedDemo) throw new Error("Free Demo button not found");
    await page.waitForTimeout(600);

    // 4) Forma u modalu – Email/Password polja (po placeholderu sa tvoje slike)
    await typeInto(page, "input[placeholder='Email']", email);
    await typeInto(page, "input[placeholder='Password']", password);

    // 5) Country – otvori dropdown klikom na tekst "Choose a country"
    let opened = await clickByText(page, "div,span,button", "Choose a country");
    if (!opened) {
      // fallback: probaj element koji u placeholderu pominje Country
      const countryInputExists = await page.$("input[placeholder*='Country' i]");
      if (countryInputExists) await countryInputExists.click();
    }
    await page.waitForTimeout(400);

    // 5a) Unesi zemlju u pretragu dropdown-a i Enter
    const searchBox = await page.$("input[type='search'], input[role='combobox']");
    if (searchBox) {
      await searchBox.type(country, { delay: 35 });
      await page.keyboard.press("Enter");
    } else {
      // Fallback – pokušaj da klikneš stavku sa nazivom zemlje (preko teksta)
      const picked = await clickByText(page, "*", country);
      if (!picked) throw new Error("Country picker not found");
    }

    await page.waitForTimeout(500);

    // 6) Submit – dugme "Practice For Free"
    const clickedSubmit = await clickByText(page, "button,a", "Practice For Free");
    if (!clickedSubmit) throw new Error("Submit button not found");
    await page.waitForTimeout(7000);

    // TODO: ovde ćemo kasnije parsirati "MetaTrader info"
    res.json({ ok: true, note: "Submit ok (no XPath). MT info scraping TBD." });
  } catch (e) {
    console.error("create-demo error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

app.get("/", (_req, res) => res.send("AvaTrade Demo Service live"));
app.listen(PORT, () => console.log("Listening on", PORT));