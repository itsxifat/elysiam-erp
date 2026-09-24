import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';

import { noEmoji } from './no-emoji.js';
import { noFloatMoney } from './no-float-money.js';
import { noInlineStyle } from './no-inline-style.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

// Built from code points rather than written literally, because this file is
// linted by the very rule it tests.
const PARTY = String.fromCodePoint(0x1f389);
const CHECK = String.fromCodePoint(0x2705);
const WARNING = String.fromCodePoint(0x26a0);
const BANGLADESH = String.fromCodePoint(0x1f1e7, 0x1f1e9);

ruleTester.run('no-emoji', noEmoji, {
  valid: [
    { code: `const label = 'Order confirmed';` },
    // The taka sign and Bangla script are text, not emoji, and must never trip
    // this rule: they are most of what this product displays.
    { code: `const total = '৳1,23,456.78';` },
    { code: `const status = 'অর্ডার নিশ্চিত হয়েছে';` },
    { code: `const arrow = 'Pending -> Confirmed';` },
    { code: `const code = 'ELB-2609-00421';` },
    { code: `const jsx = <span>Delivered</span>;` },
  ],
  invalid: [
    { code: `const done = '${CHECK} done';`, errors: [{ messageId: 'emoji' }] },
    { code: `const jsx = <div>${PARTY}</div>;`, errors: [{ messageId: 'emoji' }] },
    { code: 'const t = `total ${x} ' + PARTY + '`;', errors: [{ messageId: 'emoji' }] },
    // Pictographic warning signs are exactly what should be a lucide icon.
    { code: `const warn = '${WARNING} low stock';`, errors: [{ messageId: 'emoji' }] },
    { code: `const flag = '${BANGLADESH}';`, errors: [{ messageId: 'emoji' }] },
    { code: `const jsx = <img alt="${CHECK}" />;`, errors: [{ messageId: 'emoji' }] },
  ],
});

ruleTester.run('no-inline-style', noInlineStyle, {
  valid: [
    { code: `const a = <div className="bg-primary text-primary-foreground" />;` },
    // Per-org theming (D-034) sets the brand triple at runtime. This is the one
    // thing that must stay possible inline.
    { code: `const a = <div style={{ '--brand-h': hue }} />;` },
    { code: `const a = <div style={{ '--brand-h': hue, '--brand-c': chroma }} />;` },
    { code: `const a = <div />;` },
  ],
  invalid: [
    {
      code: `const a = <div style={{ color: 'red' }} />;`,
      errors: [{ messageId: 'inlineStyle', data: { prop: 'color' } }],
    },
    {
      code: `const a = <div style={{ marginTop: 8 }} />;`,
      errors: [{ messageId: 'inlineStyle' }],
    },
    {
      code: `const a = <div style={{ '--brand-h': hue, color: 'red' }} />;`,
      errors: [{ messageId: 'inlineStyle', data: { prop: 'color' } }],
    },
    // A style object built elsewhere cannot be checked, so it is refused rather
    // than waved through.
    { code: `const a = <div style={styles} />;`, errors: [{ messageId: 'dynamicStyle' }] },
    { code: `const a = <div style={{ ...rest }} />;`, errors: [{ messageId: 'dynamicStyle' }] },
    { code: `const a = <div style="color: red" />;`, errors: [{ messageId: 'dynamicStyle' }] },
    {
      code: `const a = <div style={{ [key]: value }} />;`,
      errors: [{ messageId: 'dynamicStyle' }],
    },
  ],
});

// M00 follow-up, closed in M03: floats never touch money outside the money module.
ruleTester.run('no-float-money', noFloatMoney, {
  valid: [
    { code: `const text = formatMoney(total);` },
    { code: `const amount = parseTaka(input);` },
    { code: `const n = Number.parseInt(value, 10);` },
    { code: `const fixed = 'toFixed';` },
    { code: `const obj = { parseFloatLike: 1 };` },
    { code: `const messages = { parseFloat: 'Use parseTaka' };` },
  ],
  invalid: [
    { code: `const s = (x / 100).toFixed(2);`, errors: [{ messageId: 'toFixed' }] },
    { code: `const s = amount['toFixed'](2);`, errors: [{ messageId: 'toFixed' }] },
    { code: `const n = parseFloat(input);`, errors: [{ messageId: 'parseFloat' }] },
    { code: `const n = Number.parseFloat(input);`, errors: [{ messageId: 'parseFloat' }] },
    { code: `const n = Number['parseFloat'](input);`, errors: [{ messageId: 'parseFloat' }] },
    { code: `const list = inputs.map(parseFloat);`, errors: [{ messageId: 'parseFloat' }] },
    { code: `const f = parseFloat;`, errors: [{ messageId: 'parseFloat' }] },
  ],
});
