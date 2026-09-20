import { noEmoji } from './no-emoji.js';
import { noInlineStyle } from './no-inline-style.js';

/**
 * The house rules that keep the UI honest. They are plain ESLint rules so they
 * run in `pnpm verify` on every commit, not only when someone remembers §24.
 */
export const elysiumPlugin = {
  meta: { name: '@elysium/config', version: '0.0.0' },
  rules: {
    'no-emoji': noEmoji,
    'no-inline-style': noInlineStyle,
  },
};

export { noEmoji, noInlineStyle };
