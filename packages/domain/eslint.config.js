import { base } from '@elysium/config/eslint/base';

export default [
  // The old website's discount engine, copied verbatim as a test oracle (M35a, D-540): it is
  // the record of what the old site did, so it is never linted into a different program.
  // So is the old site's landing-page pricing (M35b, D-550).
  {
    ignores: [
      'src/promo/oracle/old-site-discounts.js',
      'src/storefront/oracle/old-site-landing.js',
    ],
  },
  ...base({ tsconfigRootDir: import.meta.dirname }),
  {
    // The one place money is parsed and rounded (invariant 1). Everything
    // else in the repository is held to `elysium/no-float-money`.
    files: ['src/money/**'],
    rules: { 'elysium/no-float-money': 'off' },
  },
];
