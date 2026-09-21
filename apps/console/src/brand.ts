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
const DEFAULT_HUE = 259;
const DEFAULT_CHROMA = 0.17;

/** Matches `--background` in each theme. The accent must stay visible on it. */
const SURFACE: Record<'light' | 'dark', Oklch> = {
  light: { l: 1, c: 0, h: 264 },
  dark: { l: 0.165, c: 0.006, h: 264 },
};

/** Matches `--brand-l` in each theme: where the accent starts before solving. */
const PREFERRED_LIGHTNESS: Record<'light' | 'dark', number> = { light: 0.52, dark: 0.51 };

export function applyBrand(branding: LoginBranding | null): void {
  const root = document.documentElement;
  const accent = branding?.brand?.accent;

  const hue = typeof accent?.hue === 'number' ? accent.hue : DEFAULT_HUE;
  const chroma = typeof accent?.chroma === 'number' ? accent.chroma : DEFAULT_CHROMA;

  const theme = root.classList.contains('dark') ? 'dark' : 'light';
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

/** Put the shipped tokens back, for sign-out and the generic login. */
export function clearBrand(): void {
  const root = document.documentElement;
  for (const property of ['--brand-h', '--brand-c', '--brand-l', '--primary-foreground']) {
    root.style.removeProperty(property);
  }
}
