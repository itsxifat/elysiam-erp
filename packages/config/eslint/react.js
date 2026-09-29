import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

import { base } from './base.js';

/**
 * Preset for every React surface: console, portal, pos, sites, extension and
 * the shared UI packages.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function react({ tsconfigRootDir }) {
  return tseslint.config(
    ...base({ tsconfigRootDir }),
    // `configs['recommended-latest']` is still the eslintrc shape (plugins as an
    // array); the flat-config version lives under `configs.flat`.
    reactHooks.configs.flat['recommended-latest'],
    {
      languageOptions: { globals: { ...globals.browser } },
      rules: {
        'elysium/no-inline-style': 'error',
        // Architecture §24: colour, radius, shadow and duration all come from
        // the tokens. A raw colour class bypasses the theme, so it breaks dark
        // mode and per-org branding at the same time. A rule rather than a
        // `no-restricted-syntax` selector, because a selector can only see a
        // whole string literal — see the header of `rules/no-raw-colour.js`
        // for the six forms the selector let through.
        'elysium/no-raw-colour': 'error',
        'no-console': 'error',
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['react-icons', 'react-icons/*', '@heroicons/*', '@phosphor-icons/*'],
                message: 'Icons come from lucide-react only (architecture §24).',
              },
            ],
          },
        ],
      },
    },
  );
}
