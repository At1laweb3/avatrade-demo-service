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

    // 2) Cookie (ako postoji)
    try {
      await page.waitForTimeout(800);
      const [btn] = await page.$x("//button[contains(.,'Accept') or contains(.,'I agree')]");
      if (btn) await btn.click();
    } catch {}

    // 3) Free Demo (modal)
    const [freeDemoBtn] = await page.$x("//*[normalize-space(.)='Free Demo' or normalize-space(.)='Free demo']");
    if (!freeDemoBtn) throw new Error("Free Demo button not found");
    await freeDemoBtn.click();

    // 4) Forma u modalu
    await page.waitForSelector("input[placeholder='Email']", { timeout: 20000 });
    await page.type("input[placeholder='Email']", email, { delay: 40 });
    await page.type("input[placeholder='Password']", password, { delay: 40 });

    // Country
    let opener = await page.$x("//*[contains(@placeholder,'Country') or contains(.,'Choose a country')]");
    if (!opener.length) opener = await page.$x("//*[contains(.,'Choose a country') and (self::div or self::span)]");
    if (opener[0]) await opener[0].click({ delay: 50 });

    const dropdownInput = await page.$("input[type='search'], input[role='combobox']");
    if (dropdownInput) { await dropdownInput.type(country, { delay: 40 }); await page.keyboard.press("Enter"); }
    else {
      const [countryItem] = await page.$x(`//*[contains(@class,'option') or contains(@class,'item')][contains(., '${country}')]`);
      if (countryItem) await countryItem.click();
    }

    // Submit
    const [submitBtn] = await page.$x("//*[self::button or self::a][normalize-space(.)='Practice For Free']");
    if (!submitBtn) throw new Error("Submit button not found");
    await submitBtn.click();

    // Sačekaj par sekundi (kasnije ćemo čitati MT info)
    await page.waitForTimeout(7000);

    res.json({ ok: true, note: "Submit ok. MT info scraping dodajemo kasnije." });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    try { if (browser) await browser.close(); } catch {}
  }
});

app.get("/", (_, res) => res.send("AvaTrade Demo Service live"));
app.listen(PORT, () => console.log("Listening on", PORT));
