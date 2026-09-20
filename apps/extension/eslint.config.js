import { react } from '@elysium/config/eslint/react';

export default [
  { ignores: ['.wxt/**', '.output/**'] },
  ...react({ tsconfigRootDir: import.meta.dirname }),
];
