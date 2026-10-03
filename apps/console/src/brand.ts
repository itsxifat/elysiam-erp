import { resolveBrandAccent, type Oklch } from '@elysium/ui';

import type { LoginBranding } from './api.js';

/**
 * Apply an org's brand accent at runtime (D-034, architecture §24).
 *
 * The tokens are built for this: `--primary`, its hover and active states and
 * `--ring` are all written as `oklch(var(--brand-l) var(--brand-c)
 * var(--brand-h))`, so setting three variables re-themes the whole console
 * without a single component knowing an org exists.
 *
 * Lightness is solved rather than taken. A hue supplied by the client can sit
 * exactly where neither a white nor a near-black label clears AA — mid-greens
 * especially — so `resolveBrandAccent` walks lightness outward until a legible
 * combination exists. That is what keeps the accessibility floor a property of
 * the system rather than of whichever colours the client happens to send.
 */

/** The shipped defaults, so clearing a brand restores rather than breaks. */
const DEFAULT_HUE = 270;
const DEFAULT_CHROMA = 0.08;

/**
 * The most chroma a brand's accent may carry, per theme (D-441).
 *
 * The design refresh keeps one restrained accent: a deep ink, used for the primary
 * action, focus and selection only. An org's colour still sets the hue, so each brand
 * keeps its own identity, but a placeholder or a client colour at full saturation is
 * brought down to an ink of that hue rather than painting every button in a loud blue
 * or orange.
 */
const MAX_CHROMA: Record<'light' | 'dark', number> = { light: 0.09, dark: 0.11 };

/** Matches `--background` in each theme. The accent must stay visible on it. */
const SURFACE: Record<'light' | 'dark', Oklch> = {
  light: { l: 1, c: 0, h: 0 },
  dark: { l: 0.21, c: 0.003, h: 75 },
};

/** Matches `--brand-l` in each theme: where the accent starts before solving. */
const PREFERRED_LIGHTNESS: Record<'light' | 'dark', number> = { light: 0.41, dark: 0.53 };

/** The brand last applied, so a theme switch can solve its lightness again (D-441). */
let applied: { readonly branding: LoginBranding | null } | null = null;

export function applyBrand(branding: LoginBranding | null): void {
  applied = { branding };
  const root = document.documentElement;
  const accent = branding?.brand?.accent;

  const theme = root.classList.contains('dark') ? 'dark' : 'light';
  const hue = typeof accent?.hue === 'number' ? accent.hue : DEFAULT_HUE;
  const chroma = Math.min(
    typeof accent?.chroma === 'number' ? accent.chroma : DEFAULT_CHROMA,
    MAX_CHROMA[theme],
  );
  const resolved = resolveBrandAccent({
    hue,
    chroma,
    preferredLightness: PREFERRED_LIGHTNESS[theme],
    surface: SURFACE[theme],
  });

  root.style.setProperty('--brand-h', String(hue));
  root.style.setProperty('--brand-c', String(resolved.fill.c));
  root.style.setProperty('--brand-l', String(resolved.lightness));
  root.style.setProperty(
    '--primary-foreground',
    `oklch(${resolved.foreground.l} ${resolved.foreground.c} ${resolved.foreground.h})`,
  );
}

/**
 * Solve the applied brand again for the theme now on <html>. The accent's lightness is
 * per theme, so a switch from light to dark without this left the light accent on a dark
 * surface until the next reload.
 */
export function reapplyBrand(): void {
  if (applied !== null) applyBrand(applied.branding);
}

/** Put the shipped tokens back, for sign-out and the generic login. */
export function clearBrand(): void {
  applied = null;
  const root = document.documentElement;
  for (const property of ['--brand-h', '--brand-c', '--brand-l', '--primary-foreground']) {
    root.style.removeProperty(property);
  }
}
