import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { REQUIRED_ROLES, auditContrast, parseTokenFile, themeRoles } from './audit.js';
import { contrastRatio, resolveBrandAccent } from './contrast.js';
import { parseOklch, resolveToken } from './parse.js';

const css = readFileSync(fileURLToPath(new URL('../styles/tokens.css', import.meta.url)), 'utf8');
const tokens = parseTokenFile(css);

describe('design tokens (architecture §24, D-033)', () => {
  it('defines both themes and a static section', () => {
    expect(tokens.light.size).toBeGreaterThan(20);
    expect(tokens.dark.size).toBeGreaterThan(20);
    expect(tokens.static.size).toBeGreaterThan(5);
  });

  it('defines every role architecture §24 names, in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      const missing = REQUIRED_ROLES.filter((role) => !tokens[theme].has(role));
      expect(missing, `${theme} theme is missing §24 roles`).toEqual([]);
    }
  });

  it('light and dark define exactly the same roles', () => {
    const { missingFromDark, missingFromLight } = themeRoles(tokens);

    // A role defined in one theme and not the other is the failure mode that
    // makes dark mode look like an afterthought: something silently falls back
    // to an inherited or transparent value.
    expect({ missingFromDark, missingFromLight }).toEqual({
      missingFromDark: [],
      missingFromLight: [],
    });
  });

  it('keeps theme-independent tokens out of the theme sections', () => {
    const staticNames = [...tokens.static.keys()];
    const redefined = staticNames.filter((name) => tokens.light.has(name) || tokens.dark.has(name));

    expect(redefined).toEqual([]);
  });

  it('resolves every colour role to a real OKLCH value in both themes', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const name of tokens[theme].keys()) {
        // The brand triple is scalar input to the colour expressions, not a colour.
        if (name.startsWith('--brand-')) continue;

        const resolved = resolveToken(name, [tokens[theme], tokens.static]);
        expect(parseOklch(resolved), `${theme} ${name} resolved to "${resolved}"`).not.toBeNull();
      }
    }
  });
});

describe('accessibility floor (architecture §24)', () => {
  const results = auditContrast(tokens);

  it.each(results)(
    '$theme: $label — $foreground on $background meets $minimum:1',
    ({ ratio, minimum, passes, foregroundHex, backgroundHex, theme, label }) => {
      expect(
        passes,
        `${theme}: ${label} is ${ratio.toFixed(2)}:1 (${foregroundHex} on ${backgroundHex}), ` +
          `needs ${minimum}:1`,
      ).toBe(true);
    },
  );

  it('measures a known pair correctly', () => {
    // Pure black on pure white is 21:1 by definition. If this drifts, the
    // OKLCH conversion or the luminance maths is wrong and every other result
    // in this file is meaningless.
    const ratio = contrastRatio({ l: 0, c: 0, h: 0 }, { l: 1, c: 0, h: 0 });
    expect(ratio).toBeCloseTo(21, 1);
  });
});

describe('per-org brand derivation (D-034)', () => {
  it('derives primary, its states and the ring from the brand triple', () => {
    // Five brands share one design system only if the accent shades are
    // computed. If someone replaces these with literals, this test fails and
    // says why.
    for (const theme of ['light', 'dark'] as const) {
      for (const name of ['--primary', '--primary-hover', '--primary-active', '--ring']) {
        expect(tokens[theme].get(name), `${theme} ${name}`).toContain('var(--brand-');
      }
    }
  });

  it('resolves a legible accent for every brand hue an org could pick', () => {
    // Hue moves luminance a great deal at constant lightness and chroma, so no
    // single fixed pair of values suits every brand: a mid-green at the blue's
    // lightness leaves neither a white nor a black label clearing AA. The
    // contract is that the resolver the app calls when applying a brand always
    // lands somewhere legible, and moves the org's colour as little as it can.
    for (const theme of ['light', 'dark'] as const) {
      const preferred = Number(tokens[theme].get('--brand-l'));
      const chroma = Number(tokens[theme].get('--brand-c'));
      const surface = parseOklch(resolveToken('--background', [tokens[theme], tokens.static]));
      expect(surface).not.toBeNull();
      if (surface === null) continue;

      for (let hue = 0; hue < 360; hue += 15) {
        const accent = resolveBrandAccent({
          hue,
          chroma,
          preferredLightness: preferred,
          surface,
        });

        expect(
          accent.labelRatio,
          `${theme}, hue ${hue}: button label is ${accent.labelRatio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          accent.surfaceRatio,
          `${theme}, hue ${hue}: accent against the page is ${accent.surfaceRatio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          Math.abs(accent.lightness - preferred),
          `${theme}, hue ${hue}: lightness moved from ${preferred} to ${accent.lightness}`,
        ).toBeLessThanOrEqual(0.2);
      }
    }
  });

  it('the shipped default brand hue works with the shipped default foreground', () => {
    for (const theme of ['light', 'dark'] as const) {
      const primary = parseOklch(resolveToken('--primary', [tokens[theme], tokens.static]));
      const foreground = parseOklch(
        resolveToken('--primary-foreground', [tokens[theme], tokens.static]),
      );
      expect(primary).not.toBeNull();
      expect(foreground).not.toBeNull();
      if (primary === null || foreground === null) continue;

      expect(contrastRatio(primary, foreground)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
