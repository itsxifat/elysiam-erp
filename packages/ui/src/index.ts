/**
 * @elysium/ui
 *
 * shadcn/ui components, the Tailwind preset, Bangla font setup and the
 * formatting components (architecture §4, §24).
 *
 * M00 ships the design token foundation only: the tokens themselves, the
 * Tailwind preset that republishes them, and the colour maths the apps use to
 * apply an org's brand (D-034) and that CI uses to hold the accessibility floor.
 * M05 builds the component kit on top.
 *
 * Stylesheets are imported by path, not from this entry point:
 *   import '@elysium/ui/styles/tailwind.css';
 */

export {
  contrastRatio,
  oklchToRgb8,
  pickAccessibleForeground,
  relativeLuminance,
  toHex,
  FOREGROUND_CANDIDATES,
  type Oklch,
  type Rgb8,
} from './tokens/contrast.js';

export {
  parseOklch,
  parseTokenFile,
  resolveToken,
  type TokenFile,
  type TokenScope,
} from './tokens/parse.js';

export {
  auditContrast,
  themeRoles,
  CONTRAST_PAIRS,
  type ContrastPair,
  type ContrastResult,
} from './tokens/audit.js';
