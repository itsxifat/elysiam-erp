import globals from 'globals';
import tseslint from 'typescript-eslint';

import { base } from './base.js';

/**
 * Server and worker preset.
 *
 * @param {{ tsconfigRootDir: string }} options
 */
export function node({ tsconfigRootDir }) {
  return tseslint.config(...base({ tsconfigRootDir }), {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Logging goes through pino, so the structured fields survive into
      // production and the phone-number redaction actually runs (§25, §26).
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'dotenv',
              message:
                'Config is validated with Zod at startup so a missing variable fails fast. See the app env module.',
            },
          ],
        },
      ],
    },
  });
}
