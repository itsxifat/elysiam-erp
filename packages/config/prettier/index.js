import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('prettier').Config} */
export default {
  printWidth: 100,
  singleQuote: true,
  semi: true,
  trailingComma: 'all',
  arrowParens: 'always',
  bracketSpacing: true,
  // .gitattributes normalizes the tree to LF; Prettier has to agree or a
  // Windows checkout fails format:check on an otherwise clean tree.
  endOfLine: 'lf',
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindStylesheet: path.join(here, '../../ui/src/styles/tailwind.css'),
  tailwindFunctions: ['cn', 'cva'],
  overrides: [
    {
      // The tsconfig presets carry comments explaining the strict options, so
      // they need the JSONC parser rather than the strict JSON one.
      files: ['**/tsconfig*.json', '**/tsconfig/*.json', '**/*.jsonc'],
      options: { parser: 'jsonc' },
    },
    {
      files: ['**/*.md'],
      options: { proseWrap: 'preserve' },
    },
  ],
};
