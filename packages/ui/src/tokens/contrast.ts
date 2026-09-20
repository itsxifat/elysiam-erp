/**
 * OKLCH to sRGB, and WCAG contrast.
 *
 * The tokens are authored in OKLCH because it gives perceptually even lightness,
 * which is what makes the per-org brand accent (D-034) derivable from a single
 * hue and chroma. WCAG, however, is defined on sRGB relative luminance, so the
 * only honest way to check the accessibility floor in architecture §24 is to
 * convert the way a browser does — including clamping to the sRGB gamut and
 * quantising to 8 bits — and then measure.
 */

export interface Oklch {
  /** Perceptual lightness, 0-1. */
  readonly l: number;
  /** Chroma, 0 to roughly 0.4. */
  readonly c: number;
  /** Hue angle in degrees. */
  readonly h: number;
}

export interface Rgb8 {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** sRGB transfer function (linear light to encoded value). */
function encodeGamma(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel));
  const encoded =
    clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(encoded * 255)));
}

/** Inverse sRGB transfer function (encoded 0-255 back to linear light). */
function decodeGamma(channel8: number): number {
  const v = channel8 / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Convert OKLCH to an 8-bit sRGB triple, clamped to the gamut exactly as a
 * browser would display it.
 */
export function oklchToRgb8({ l, c, h }: Oklch): Rgb8 {
  const hueRadians = (h * Math.PI) / 180;
  const a = c * Math.cos(hueRadians);
  const b = c * Math.sin(hueRadians);

  const lCone = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mCone = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sCone = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return {
    r: encodeGamma(4.0767416621 * lCone - 3.3077115913 * mCone + 0.2309699292 * sCone),
    g: encodeGamma(-1.2684380046 * lCone + 2.6097574011 * mCone - 0.3413193965 * sCone),
    b: encodeGamma(-0.0041960863 * lCone - 0.7034186147 * mCone + 1.707614701 * sCone),
  };
}

/** WCAG 2.x relative luminance of an 8-bit sRGB colour. */
export function relativeLuminance({ r, g, b }: Rgb8): number {
  return 0.2126 * decodeGamma(r) + 0.7152 * decodeGamma(g) + 0.0722 * decodeGamma(b);
}

/** WCAG 2.x contrast ratio between two colours, from 1 to 21. */
export function contrastRatio(first: Oklch, second: Oklch): number {
  const a = relativeLuminance(oklchToRgb8(first));
  const b = relativeLuminance(oklchToRgb8(second));
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Hex form, for readable test failures and for review screenshots. */
export function toHex(colour: Oklch): string {
  const { r, g, b } = oklchToRgb8(colour);
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Choose the foreground that reads best on a given fill.
 *
 * Per-org branding (D-034) lets an org pick any accent hue, and hue changes
 * luminance a lot at constant lightness and chroma: a yellow accent and a blue
 * accent authored as `oklch(0.52 0.17 h)` are nowhere near equally bright. A
 * fixed white label would fail AA on the yellow one.
 *
 * So when an org's brand is applied, the app calls this to set
 * `--primary-foreground` alongside the brand triple, instead of hoping one
 * foreground suits every brand.
 */
export function pickAccessibleForeground(
  background: Oklch,
  candidates: readonly Oklch[],
): { readonly colour: Oklch; readonly ratio: number } {
  let best = { colour: candidates[0] ?? background, ratio: 0 };

  for (const candidate of candidates) {
    const ratio = contrastRatio(candidate, background);
    if (ratio > best.ratio) best = { colour: candidate, ratio };
  }

  return best;
}

/** The two foregrounds the token set offers for a brand fill: near-white and near-black. */
export const FOREGROUND_CANDIDATES: readonly Oklch[] = [
  { l: 0.985, c: 0.002, h: 264 },
  { l: 0.21, c: 0.006, h: 264 },
];

export interface BrandAccentInput {
  /** The org's brand hue, in degrees. */
  readonly hue: number;
  /** The org's brand chroma. */
  readonly chroma: number;
  /** Where to start looking; the theme's shipped `--brand-l`. */
  readonly preferredLightness: number;
  /** The surface the accent sits on, so the fill stays visible as an icon or link. */
  readonly surface: Oklch;
  readonly candidates?: readonly Oklch[];
  /** AA for the button label. */
  readonly minimumLabelRatio?: number;
  /** AA for a UI boundary: the fill must be distinguishable from the surface. */
  readonly minimumSurfaceRatio?: number;
}

export interface BrandAccent {
  readonly lightness: number;
  readonly fill: Oklch;
  readonly foreground: Oklch;
  readonly labelRatio: number;
  readonly surfaceRatio: number;
}

/**
 * Solve for a usable accent from an org's brand hue and chroma (D-034).
 *
 * Picking a foreground is not enough on its own. Hue moves luminance so much at
 * constant lightness that some hues — mid-greens especially — sit exactly where
 * neither a white nor a near-black label clears AA. The fix is to let lightness
 * move: start at the theme's shipped value and walk outward until a legible
 * combination exists, preferring the smallest change so the org still gets the
 * colour it asked for.
 *
 * The app calls this when it applies an org's brand and writes the result into
 * `--brand-l` and `--primary-foreground`. That is why this lives in the shipped
 * package rather than in a test helper.
 */
export function resolveBrandAccent(input: BrandAccentInput): BrandAccent {
  const {
    hue,
    chroma,
    preferredLightness,
    surface,
    candidates = FOREGROUND_CANDIDATES,
    minimumLabelRatio = 4.5,
    minimumSurfaceRatio = 3,
  } = input;

  const evaluate = (lightness: number): BrandAccent => {
    const fill: Oklch = { l: lightness, c: chroma, h: hue };
    const best = pickAccessibleForeground(fill, candidates);
    return {
      lightness,
      fill,
      foreground: best.colour,
      labelRatio: best.ratio,
      surfaceRatio: contrastRatio(fill, surface),
    };
  };

  const acceptable = (accent: BrandAccent): boolean =>
    accent.labelRatio >= minimumLabelRatio && accent.surfaceRatio >= minimumSurfaceRatio;

  const start = evaluate(preferredLightness);
  if (acceptable(start)) return start;

  // Walk outward in 0.01 steps, nearest first, so the org's colour moves as
  // little as the accessibility floor allows.
  for (let step = 1; step <= 45; step += 1) {
    const delta = step / 100;
    for (const lightness of [preferredLightness - delta, preferredLightness + delta]) {
      if (lightness <= 0.05 || lightness >= 0.98) continue;
      const accent = evaluate(lightness);
      if (acceptable(accent)) return accent;
    }
  }

  // No lightness works at this chroma. Desaturating always converges, because a
  // neutral grey has a legible label at some lightness.
  if (chroma > 0.02) {
    return resolveBrandAccent({ ...input, chroma: Math.max(0.02, chroma - 0.02) });
  }

  return start;
}
