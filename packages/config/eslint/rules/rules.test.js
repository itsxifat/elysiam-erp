import { RuleTester } from 'eslint';
import { afterAll, describe, it } from 'vitest';

import { noEmoji } from './no-emoji.js';
import { noFloatMoney } from './no-float-money.js';
import { noInlineStyle } from './no-inline-style.js';
import { noRawColour } from './no-raw-colour.js';

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

// M05 check 8, closed after an audit: the palette check used to be a
// `no-restricted-syntax` selector with no tests at all, and it missed every form
// below that is marked "used to pass". The Tailwind preset does not reset the
// default palette, so each of those compiled to a real colour in shipped CSS.
ruleTester.run('no-raw-colour', noRawColour, {
  valid: [
    { code: `const a = <div className="bg-primary text-primary-foreground" />;` },
    // Tokens with an opacity modifier and variants are still tokens.
    { code: `const a = cn('bg-muted hover:bg-muted/80', 'border-border');` },
    { code: `const a = 'bg-transparent text-current border-inherit fill-none';` },
    // Plain words and non-colour utilities that happen to share a prefix.
    { code: `const a = 'white';` },
    { code: `const a = 'text-sm font-medium to-do';` },
    { code: `const a = 'grid-cols-[1fr_auto] shadow-[var(--shadow-card)]';` },
    // A token referenced through an arbitrary value is not a raw colour.
    { code: `const a = 'bg-[var(--brand)] text-[length:var(--text-sm)]';` },
    // A hex colour outside a class — a token file, a chart palette — is not a class.
    { code: `const hex = '#ffffff';` },
    { code: 'const a = `bg-${tone} text-muted-foreground`;' },
    { code: 'const a = `${base} hover:bg-muted`;' },
  ],
  invalid: [
    {
      code: `const a = <div className="bg-blue-500" />;`,
      errors: [{ messageId: 'palette', data: { token: 'bg-blue-500' } }],
    },
    // Used to pass: the opacity modifier sat where the selector wanted a space.
    {
      code: `const a = <div className="p-2 bg-blue-500/50" />;`,
      errors: [{ messageId: 'palette', data: { token: 'bg-blue-500/50' } }],
    },
    // Used to pass: a variant prefix meant no whitespace before the utility.
    {
      code: `const a = cn('hover:bg-red-600', 'dark:text-slate-50');`,
      errors: [
        { messageId: 'palette', data: { token: 'hover:bg-red-600' } },
        { messageId: 'palette', data: { token: 'dark:text-slate-50' } },
      ],
    },
    {
      code: `const v = cva('base', { variants: { tone: { danger: 'text-rose-950' } } });`,
      errors: [{ messageId: 'palette', data: { token: 'text-rose-950' } }],
    },
    // Used to pass: black and white are not palette shades.
    {
      code: `const a = <div className="bg-white text-black" />;`,
      errors: [
        { messageId: 'palette', data: { token: 'bg-white' } },
        { messageId: 'palette', data: { token: 'text-black' } },
      ],
    },
    {
      code: `const a = 'dark:bg-black/80 border-x-white ring-offset-blue-500';`,
      errors: [
        { messageId: 'palette', data: { token: 'dark:bg-black/80' } },
        { messageId: 'palette', data: { token: 'border-x-white' } },
        { messageId: 'palette', data: { token: 'ring-offset-blue-500' } },
      ],
    },
    // Used to pass: an arbitrary value is a raw colour with extra steps.
    {
      code: `const a = 'bg-[#fff] text-[rgb(0_0_0)]';`,
      errors: [
        { messageId: 'arbitrary', data: { token: 'bg-[#fff]' } },
        { messageId: 'arbitrary', data: { token: 'text-[rgb(0_0_0)]' } },
      ],
    },
    {
      code: `const a = 'shadow-[0_1px_2px_rgba(0,0,0,0.1)] [color:#123456]';`,
      errors: [
        { messageId: 'arbitrary', data: { token: 'shadow-[0_1px_2px_rgba(0,0,0,0.1)]' } },
        { messageId: 'arbitrary', data: { token: '[color:#123456]' } },
      ],
    },
    {
      code: `const a = 'data-[state=open]:bg-white !bg-red-500 bg-green-500!';`,
      errors: [
        { messageId: 'palette', data: { token: 'data-[state=open]:bg-white' } },
        { messageId: 'palette', data: { token: '!bg-red-500' } },
        { messageId: 'palette', data: { token: 'bg-green-500!' } },
      ],
    },
    // An object key in `cn({...})` is a string literal too.
    {
      code: `const a = cn({ 'bg-emerald-500': ok });`,
      errors: [{ messageId: 'palette', data: { token: 'bg-emerald-500' } }],
    },
    // Used to pass: a template literal is not a `Literal` node.
    {
      code: 'const a = `px-2 bg-blue-500 ${active ? "ring-2" : ""}`;',
      errors: [{ messageId: 'palette', data: { token: 'bg-blue-500' } }],
    },
    // Used to pass: the colour is chosen at runtime, so no whole class is ever
    // visible — but the shade after the hole gives it away.
    {
      code: 'const a = `rounded bg-${tone}-500`;',
      errors: [{ messageId: 'dynamic', data: { token: 'bg-' } }],
    },
    {
      code: 'const a = `hover:text-${tone}-700/50 p-2`;',
      errors: [{ messageId: 'dynamic', data: { token: 'text-' } }],
    },
  ],
});
