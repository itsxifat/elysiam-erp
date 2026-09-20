import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

import { base } from './base.js';

const PALETTES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
].join('|');

const COLOUR_UTILITIES = [
  'bg',
  'text',
  'border',
  'ring',
  'from',
  'via',
  'to',
  'fill',
  'stroke',
  'shadow',
  'outline',
  'decoration',
  'divide',
  'accent',
  'caret',
  'placeholder',
].join('|');

// Matches a raw Tailwind palette class such as `bg-blue-500` anywhere in a
// string literal. `String.raw` keeps the regex readable: the selector this rule
// receives needs literal backslashes, and writing them doubled inside an
// ordinary string is how the escaping gets lost.
const RAW_PALETTE_CLASS = String.raw`Literal[value=/(?:^|\s)(?:${COLOUR_UTILITIES})-(?:${PALETTES})-\d{2,3}(?:\s|$)/]`;

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
        // Architecture §24: colour, radius, shadow and duration all come from
        // the tokens. A raw palette class bypasses the theme, so it breaks dark
        // mode and per-org branding at the same time.
        'no-restricted-syntax': [
          'error',
          {
            selector: RAW_PALETTE_CLASS,
            message:
              'Raw Tailwind palette colour. Use a semantic token class (bg-primary, text-muted-foreground, border-border) so dark mode and per-org branding keep working.',
          },
        ],
      },
    },
  );
}
