const express = require('express');
const puppeteer = require('puppeteer-core');
const { PDFDocument } = require('pdf-lib');

const app = express();
app.use(express.json({ limit: '10mb' }));

const API_KEY = process.env.RENDER_API_KEY;
const CHROMIUM_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

// --- Seguridad simple: exige la cabecera x-api-key ---
function checkAuth(req, res, next) {
  const key = req.header('x-api-key');
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Espera hasta que ninguno de los textos de "cargando" siga presente en la página
async function waitUntilLoaded(page, loadingTexts, timeoutMs = 20000) {
  await page.waitForFunction(
    (texts) => {
      const body = document.body.innerText || '';
      return !texts.some((t) => body.includes(t));
    },
    { timeout: timeoutMs },
    loadingTexts
  );
}

// Busca un elemento clicable cuyo texto coincida exactamente y le hace click
async function clickTabByText(page, text) {
  const clicked = await page.evaluate((label) => {
    const candidates = Array.from(document.querySelectorAll('button, a, div, span, li'));
    const el = candidates.find((e) => e.textContent && e.textContent.trim() === label);
    if (el) {
      el.click();
      return true;
    }
    return false;
  }, text);
  if (!clicked) {
    throw new Error(`No se encontró la pestaña con texto "${text}"`);
  }
}

/**
 * POST /render
 * body: {
 *   url: string,                 // URL del dashboard
 *   tabs?: string[],             // textos exactos de las pestañas a recorrer, en orden (opcional)
 *   loadingTexts?: string[],     // textos que indican "aún cargando" (opcional, hay un valor por defecto)
 *   waitMs?: number              // espera extra tras cada click de pestaña, en ms (opcional)
 * }
 * respuesta: { pdfBase64: string }  // PDF combinado (todas las pestañas en un único PDF), en base64
 */
app.post('/render', checkAuth, async (req, res) => {
  const {
    url,
    tabs,
    loadingTexts = ['Conectando con el servidor...', 'Cargando datos...'],
    waitMs = 1500,
  } = req.body;

  if (!url) return res.status(400).json({ error: 'Falta "url"' });

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: 'new',
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await waitUntilLoaded(page, loadingTexts);

    const merged = await PDFDocument.create();
    const tabList = Array.isArray(tabs) && tabs.length ? tabs : [null];

    for (const tabLabel of tabList) {
      if (tabLabel) {
        await clickTabByText(page, tabLabel);
        await new Promise((r) => setTimeout(r, waitMs));
        await waitUntilLoaded(page, loadingTexts);
      }
      const buffer = await page.pdf({ format: 'A4', printBackground: true });
      const doc = await PDFDocument.load(buffer);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }

    const bytes = await merged.save();
    await browser.close();
    res.json({ pdfBase64: Buffer.from(bytes).toString('base64') });
  } catch (err) {
    if (browser) await browser.close();
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Render service listening on ${port}`));
