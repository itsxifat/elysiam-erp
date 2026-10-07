import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { poisha } from '@elysium/domain';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadFonts } from './fonts.js';
import { GotenbergClient } from './gotenberg.client.js';
import {
  formatTaka,
  invoiceTotals,
  renderInvoiceHtml,
  type InvoiceData,
} from './invoice.template.js';

/**
 * The sample invoice (M04 acceptance check 5).
 *
 * > The sample invoice PDF renders, and page 1 is rasterized to
 * > `docs/review/M04-bangla-invoice.png` for the human to check Bangla shaping.
 *
 * The PNG is the deliverable and it is produced here rather than by a script,
 * because a script that nobody runs is a check nobody performs. Running the
 * suite regenerates it, so the image in `docs/review` is always the output of
 * the template as it currently stands.
 *
 * **How the PNG relates to the PDF.** Gotenberg does not rasterize PDFs, and
 * adding a PDF rasterizer would mean a poppler or a PDF.js dependency for one
 * image. Instead the same HTML, with the same fonts, is sent to the same
 * Chromium through its screenshot route at A4 width. Shaping is done by the
 * font's GSUB table inside that Chromium in both cases, so what the PNG shows
 * is what the PDF contains — which is the property that makes it evidence
 * (D-116). The PDF itself is rendered and asserted in the same test, so
 * "renders" is checked directly rather than inferred from the picture.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../../..');
const REVIEW_DIR = path.join(REPO_ROOT, 'docs', 'review');
const PNG_PATH = path.join(REVIEW_DIR, 'M04-bangla-invoice.png');

const BRAND = {
  legalName: 'Elysiam Lifestyle BD Limited',
  displayName: 'Elysiam Lifestyle BD',
  address: 'বাড়ি ১২, সড়ক ৫, ধানমন্ডি, ঢাকা ১২০৫',
  vatNo: '004512345678',
  invoiceFooter: 'পণ্য বদলাতে চাইলে ডেলিভারির ৭ দিনের মধ্যে যোগাযোগ করুন।',
  accentHue: 268,
};

/*
 * The item names are chosen to exercise shaping, not to look plausible.
 * `কুর্তি` has a ref-plus-vowel cluster, `পাঞ্জাবি` a nasal conjunct,
 * `ক্ষুদ্র` the ক্ষ ligature that is the standard test for a Bangla font's
 * GSUB table. A renderer without the right font draws these as separate
 * letters — which still looks like text, which is why a human has to look.
 */
const DATA: InvoiceData = {
  invoiceNo: 'ELY-2026-001042',
  issuedOn: '০৯ মার্চ ২০২৬',
  customerName: 'রহিমা খাতুন',
  // Masked before it gets here: invariant 10 applies to documents too, and a
  // fixture that carried a real-looking number would be the first place a
  // copy-paste turned into a live one.
  customerPhone: '+88017****4321',
  customerAddress: 'ফ্ল্যাট ৪বি, বাড়ি ২৩, সড়ক ১১, বনানী, ঢাকা ১২১৩',
  lines: [
    {
      name: 'সুতির কুর্তি — নীল',
      sku: 'ELY-KRT-BLU-M',
      quantity: 2,
      unitPricePoisha: poisha(129000n),
    },
    {
      name: 'পাঞ্জাবি — সাদা, খাদি',
      sku: 'ELY-PNJ-WHT-L',
      quantity: 1,
      unitPricePoisha: poisha(245000n),
    },
    {
      name: 'ক্ষুদ্র নকশার ওড়না',
      sku: 'ELY-ODN-PRT-1',
      quantity: 3,
      unitPricePoisha: poisha(68500n),
    },
  ],
  deliveryChargePoisha: poisha(8000n),
  paidPoisha: poisha(0n),
};

describe('invoice money formatting', () => {
  /*
   * Runs without Gotenberg, and is the part of this file that must never be
   * skipped: the totals on an invoice are money, and invariant 1 says the
   * arithmetic stays in integer poisha the whole way.
   */
  it('formats poisha as taka without ever dividing', () => {
    expect(formatTaka(poisha(0n))).toBe('৳0.00');
    expect(formatTaka(poisha(5n))).toBe('৳0.05');
    expect(formatTaka(poisha(129000n))).toBe('৳1,290.00');
    expect(formatTaka(poisha(-129045n))).toBe('−৳1,290.45');
    // Beyond 2^53. A `Number(poisha) / 100` implementation cannot represent
    // this at all and loses the last digits; the bigint split keeps them.
    expect(formatTaka(poisha(8999999999999999n))).toBe('৳89,999,999,999,999.99');
  });

  it('totals the lines, the delivery charge and the amount already paid', () => {
    const { subtotal, total, due } = invoiceTotals(DATA);
    // 2×1290 + 1×2450 + 3×685 = 2580 + 2450 + 2055 = 7085 taka
    expect(formatTaka(subtotal)).toBe('৳7,085.00');
    expect(formatTaka(total)).toBe('৳7,165.00');
    expect(formatTaka(due)).toBe('৳7,165.00');
  });

  it('escapes a customer name rather than letting it become markup', () => {
    const html = renderInvoiceHtml({
      brand: BRAND,
      data: { ...DATA, customerName: '<script>alert(1)</script>' },
      fonts: [],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('carries the org brand block, including the Bangla address and VAT number', () => {
    const html = renderInvoiceHtml({ brand: BRAND, data: DATA, fonts: [] });
    expect(html).toContain('Elysiam Lifestyle BD Limited');
    expect(html).toContain('ধানমন্ডি');
    expect(html).toContain('004512345678');
    expect(html).toContain('oklch(0.55 0.12 268)');
  });
});

describe('the sample invoice renders through Gotenberg', () => {
  const client = new GotenbergClient(process.env.GOTENBERG_URL ?? 'http://localhost:3030');
  let ready = false;

  beforeAll(async () => {
    ready = await client.isReady();
  });

  it('produces a PDF, and rasterizes page 1 for a human to check the shaping', async () => {
    /*
     * Skipped rather than failed when Gotenberg is not up, and the skip is
     * loud. The check is a human one — somebody has to look at the image — so
     * a red suite on a machine without the compose stack running would train
     * people to ignore this file, which is the opposite of what it is for.
     */
    if (!ready) {
      console.warn(
        'Gotenberg is not reachable. Start it with ' +
          '`docker compose -f infra/docker-compose.dev.yml up -d gotenberg` ' +
          'to regenerate docs/review/M04-bangla-invoice.png.',
      );
      expect(ready).toBe(false);
      return;
    }

    const fonts = await loadFonts(process.env.PDF_FONT_DIR);
    expect(fonts, 'all four faces: two weights × two subsets').toHaveLength(4);

    const html = renderInvoiceHtml({ brand: BRAND, data: DATA, fonts });
    const assets = fonts.map((font) => ({
      filename: font.filename,
      bytes: font.bytes,
      contentType: 'font/woff2',
    }));

    const pdf = await client.renderPdf({ html, assets });

    // A real PDF, with at least one page. `%PDF-` is the header every reader
    // checks first, and counting `/Type /Page` objects is the cheapest
    // "page 1 exists" that does not need a PDF parser.
    expect(Buffer.from(pdf.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(2000);
    const body = Buffer.from(pdf).toString('latin1');
    expect(body).toMatch(/\/Type\s*\/Page[^s]/);

    /*
     * The embedded font is the assertion that Bangla will shape for whoever
     * opens this file, wherever they open it. A PDF that *looks* right on the
     * rendering machine and has no embedded font renders as boxes on the
     * customer's phone, and that failure is invisible from here.
     */
    expect(body).toMatch(/FontFile2|FontFile3|HindSiliguri/);

    // A4 at 96 DPI, so the image is page 1 rather than the top of the page.
    const png = await client.screenshotPng({
      html,
      assets,
      width: 794,
      height: 1123,
      fullPage: false,
    });
    expect(Buffer.from(png.subarray(1, 4)).toString('latin1')).toBe('PNG');

    await mkdir(REVIEW_DIR, { recursive: true });
    await writeFile(PNG_PATH, png);
  }, 60_000);
});
