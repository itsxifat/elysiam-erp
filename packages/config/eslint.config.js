import tseslint from 'typescript-eslint';

import { base } from './eslint/base.js';

export default [
  ...base({ tsconfigRootDir: import.meta.dirname }),
  {
    // This package *is* the toolchain. Everything outside src/ is plain JS that
    // runs before any build, so no tsconfig owns it and type-aware rules cannot
    // parse it.
    files: ['eslint/**/*.js', 'prettier/**/*.js', 'vitest/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
];
