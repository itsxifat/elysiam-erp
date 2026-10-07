import { react } from '@elysium/config/eslint/react';

export default [
  // `public/` is copied as is: the theme script that runs before the bundle (no TypeScript).
  { ignores: ['public/**'] },
  ...react({ tsconfigRootDir: import.meta.dirname }),
];
