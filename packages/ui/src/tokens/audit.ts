/**
 * The accessibility floor from architecture §24, expressed as data.
 *
 * M00 asserts this over the token file. M05 reuses the same list for its
 * contrast acceptance check, so the two can never drift apart.
 */

import { contrastRatio, toHex, type Oklch } from './contrast.js';
import {
  parseOklch,
  parseTokenFile,
  resolveToken,
  type TokenFile,
  type TokenScope,
} from './parse.js';

/**
 * The semantic roles architecture §24 names explicitly.
 *
 * Parity and preset coverage are both derived from whatever the light theme
 * happens to contain, so without this list a role deleted from *both* themes
 * would pass every check. This is the floor: adding roles is free, removing one
 * of these is a decision that has to be argued for.
 */
export const REQUIRED_ROLES: readonly string[] = [
  '--background',
  '--foreground',
  '--muted',
  '--muted-foreground',
  '--border',
  '--ring',
  '--primary',
  '--primary-foreground',
  '--destructive',
  '--destructive-foreground',
  '--success',
  '--success-foreground',
  '--warning',
  '--warning-foreground',
];

export interface ContrastPair {
  /** The token painted on top. */
  readonly foreground: string;
  /** The token painted underneath. */
  readonly background: string;
  /** WCAG AA: 4.5 for body text, 3 for large text and UI boundaries. */
  readonly minimum: number;
  /** What breaks for a user if this pair fails. */
  readonly label: string;
}

export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  { foreground: '--foreground', background: '--background', minimum: 4.5, label: 'body text' },
  { foreground: '--card-foreground', background: '--card', minimum: 4.5, label: 'text on a card' },
  {
    foreground: '--popover-foreground',
    background: '--popover',
    minimum: 4.5,
    label: 'text in a popover, dialog or command palette',
  },
  {
    foreground: '--muted-foreground',
    background: '--background',
    minimum: 4.5,
    label: 'secondary text',
  },
  {
    foreground: '--muted-foreground',
    background: '--muted',
    minimum: 4.5,
    label: 'secondary text on a muted fill',
  },
  {
    foreground: '--secondary-foreground',
    background: '--secondary',
    minimum: 4.5,
    label: 'secondary button',
  },
  {
    foreground: '--accent-foreground',
    background: '--accent',
    minimum: 4.5,
    label: 'text on a hovered row',
  },
  {
    foreground: '--primary-text',
    background: '--background',
    minimum: 4.5,
    label: 'a link or selected value in the brand colour',
  },
  {
    foreground: '--primary-text',
    background: '--card',
    minimum: 4.5,
    label: 'a link in the brand colour inside a table or card',
  },
  // M38a: an error message or a refusal as text, on the page, a card or a dialog.
  {
    foreground: '--destructive-text',
    background: '--background',
    minimum: 4.5,
    label: 'error text on the page',
  },
  {
    foreground: '--destructive-text',
    background: '--card',
    minimum: 4.5,
    label: 'error text inside a card',
  },
  {
    foreground: '--destructive-text',
    background: '--popover',
    minimum: 4.5,
    label: 'error text in a dialog',
  },
  {
    foreground: '--primary-foreground',
    background: '--primary',
    minimum: 4.5,
    label: 'primary button label',
  },
  {
    foreground: '--primary-foreground',
    background: '--primary-hover',
    minimum: 4.5,
    label: 'primary button label while hovered',
  },
  {
    foreground: '--primary-foreground',
    background: '--primary-active',
    minimum: 4.5,
    label: 'primary button label while pressed',
  },
  {
    foreground: '--destructive-foreground',
    background: '--destructive',
    minimum: 4.5,
    label: 'destructive button label',
  },
  {
    foreground: '--success-foreground',
    background: '--success',
    minimum: 4.5,
    label: 'solid success fill',
  },
  {
    foreground: '--warning-foreground',
    background: '--warning',
    minimum: 4.5,
    label: 'solid warning fill',
  },
  { foreground: '--info-foreground', background: '--info', minimum: 4.5, label: 'solid info fill' },
  {
    foreground: '--destructive-subtle-foreground',
    background: '--destructive-subtle',
    minimum: 4.5,
    label: 'cancelled or returned status badge',
  },
  {
    foreground: '--success-subtle-foreground',
    background: '--success-subtle',
    minimum: 4.5,
    label: 'delivered status badge',
  },
  {
    foreground: '--warning-subtle-foreground',
    background: '--warning-subtle',
    minimum: 4.5,
    label: 'pending or on-hold status badge',
  },
  {
    foreground: '--info-subtle-foreground',
    background: '--info-subtle',
    minimum: 4.5,
    label: 'informational status badge',
  },
  // The design refresh's surfaces (D-440): the chrome's ground, the selected entry and the
  // accent tint. Each carries text, so each holds body-text contrast.
  {
    foreground: '--canvas-foreground',
    background: '--canvas',
    minimum: 4.5,
    label: 'navigation text on the sidebar',
  },
  {
    foreground: '--muted-foreground',
    background: '--canvas',
    minimum: 4.5,
    label: 'navigation group label on the sidebar',
  },
  {
    foreground: '--muted-foreground',
    background: '--card',
    minimum: 4.5,
    label: 'secondary text inside a card',
  },
  {
    foreground: '--selected-foreground',
    background: '--selected',
    minimum: 4.5,
    label: 'the active navigation entry or a chosen filter',
  },
  {
    foreground: '--muted-foreground',
    background: '--accent',
    minimum: 4.5,
    label: 'secondary text on a hovered row',
  },
  {
    foreground: '--primary-text',
    background: '--primary-subtle',
    minimum: 4.5,
    label: 'a selected tab or chip on the accent tint',
  },
  {
    foreground: '--border',
    background: '--background',
    minimum: 1.3,
    label: 'hairline separating regions is actually visible',
  },
  {
    foreground: '--input',
    background: '--background',
    minimum: 1.5,
    label: "a field's edge reads as a field",
  },
  {
    foreground: '--ring',
    background: '--background',
    minimum: 3,
    label: 'focus ring, which is how keyboard operators navigate',
  },
  {
    foreground: '--primary',
    background: '--background',
    minimum: 3,
    label: 'brand accent used as an icon or link',
  },
];

export interface ContrastResult extends ContrastPair {
  readonly theme: Exclude<TokenScope, 'static'>;
  readonly ratio: number;
  readonly passes: boolean;
  readonly foregroundHex: string;
  readonly backgroundHex: string;
}

function colourOf(name: string, tokens: TokenFile, theme: Exclude<TokenScope, 'static'>): Oklch {
  const resolved = resolveToken(name, [tokens[theme], tokens.static]);
  const colour = parseOklch(resolved);
  if (colour === null) {
    throw new Error(`Token "${name}" in the ${theme} theme is not a colour: "${resolved}"`);
  }
  return colour;
}

/** Measure every pair in both themes. */
export function auditContrast(tokens: TokenFile): readonly ContrastResult[] {
  const results: ContrastResult[] = [];

  for (const theme of ['light', 'dark'] as const) {
    for (const pair of CONTRAST_PAIRS) {
      const foreground = colourOf(pair.foreground, tokens, theme);
      const background = colourOf(pair.background, tokens, theme);
      const ratio = contrastRatio(foreground, background);

      results.push({
        ...pair,
        theme,
        ratio,
        passes: ratio >= pair.minimum,
        foregroundHex: toHex(foreground),
        backgroundHex: toHex(background),
      });
    }
  }

  return results;
}

/** Every colour role the two themes must agree on. */
export function themeRoles(tokens: TokenFile): {
  readonly light: readonly string[];
  readonly dark: readonly string[];
  readonly missingFromDark: readonly string[];
  readonly missingFromLight: readonly string[];
} {
  const light = [...tokens.light.keys()].sort();
  const dark = [...tokens.dark.keys()].sort();

  return {
    light,
    dark,
    missingFromDark: light.filter((name) => !tokens.dark.has(name)),
    missingFromLight: dark.filter((name) => !tokens.light.has(name)),
  };
}

export { parseTokenFile };
