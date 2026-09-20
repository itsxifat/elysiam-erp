/**
 * Read tokens.css the way a browser would.
 *
 * The tests need the *computed* value of a token, not its source text:
 * `--primary` is written as `oklch(var(--brand-l) var(--brand-c) var(--brand-h))`
 * so that per-org theming (D-034) works, and `--ring` adds a `calc()` on top.
 * Asserting on the source string would prove nothing about what people see.
 *
 * The resolver is deliberately narrow: it handles `var()` substitution and
 * unitless `calc()` arithmetic, and throws on anything else. A token written
 * with an expression this cannot evaluate fails the test suite loudly rather
 * than slipping through unchecked.
 */

import type { Oklch } from './contrast.js';

export type TokenScope = 'static' | 'light' | 'dark';

export type TokenFile = Readonly<Record<TokenScope, ReadonlyMap<string, string>>>;

const SECTION_MARKERS: readonly (readonly [TokenScope, RegExp])[] = [
  ['static', /\/\*\s*@tokens:static\s*\*\//],
  ['light', /\/\*\s*@tokens:theme\s+light\s*\*\//],
  ['dark', /\/\*\s*@tokens:theme\s+dark\s*\*\//],
];

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseDeclarations(block: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const statement of stripComments(block).split(';')) {
    const separator = statement.indexOf(':');
    if (separator === -1) continue;

    const name = statement.slice(0, separator).trim();
    if (!name.startsWith('--')) continue;

    values.set(
      name,
      statement
        .slice(separator + 1)
        .trim()
        .replace(/\s+/g, ' '),
    );
  }

  return values;
}

/** Split tokens.css into its marked sections and parse each one's declarations. */
export function parseTokenFile(css: string): TokenFile {
  const bounds = SECTION_MARKERS.map(([scope, marker]) => {
    const match = marker.exec(css);
    if (match === null) throw new Error(`tokens.css is missing its "${scope}" section marker`);
    return { scope, start: match.index + match[0].length };
  }).sort((a, b) => a.start - b.start);

  const sections = {} as Record<TokenScope, ReadonlyMap<string, string>>;

  bounds.forEach((bound, index) => {
    const next = bounds[index + 1];
    const region = css.slice(bound.start, next?.start ?? css.length);

    const open = region.indexOf('{');
    const close = region.indexOf('}', open);
    if (open === -1 || close === -1) {
      throw new Error(`tokens.css section "${bound.scope}" has no declaration block`);
    }

    sections[bound.scope] = parseDeclarations(region.slice(open + 1, close));
  });

  return sections;
}

function evaluateCalc(value: string): string {
  return value.replace(/calc\(([^()]*)\)/g, (_whole, expression: string) => {
    const match = /^\s*(-?[\d.]+)\s*([+\-*/])\s*(-?[\d.]+)\s*$/.exec(expression);
    if (match === null) {
      throw new Error(
        `Unsupported calc() in tokens.css: "calc(${expression})". ` +
          `The token resolver handles unitless binary arithmetic only.`,
      );
    }

    const left = Number(match[1]);
    const right = Number(match[3]);
    const operator = match[2];

    if (operator === '+') return String(left + right);
    if (operator === '-') return String(left - right);
    if (operator === '*') return String(left * right);
    if (operator === '/') return String(left / right);

    throw new Error(`Unsupported calc() operator "${String(operator)}" in tokens.css`);
  });
}

/**
 * Resolve a token to its computed value, looking names up through the given
 * scopes in order (theme first, then static).
 */
export function resolveToken(name: string, scopes: readonly ReadonlyMap<string, string>[]): string {
  const lookup = (key: string): string | undefined => {
    for (const scope of scopes) {
      const found = scope.get(key);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const seed = lookup(name);
  if (seed === undefined) throw new Error(`Token "${name}" is not defined in any scope`);

  let value = seed;
  for (let pass = 0; pass < 16; pass += 1) {
    if (!value.includes('var(')) return evaluateCalc(value);

    value = value.replace(
      /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g,
      (_whole, key: string, fallback?: string) => {
        const found = lookup(key);
        if (found !== undefined) return found;
        if (fallback !== undefined) return fallback.trim();
        throw new Error(`Token "${name}" references "${key}", which is not defined`);
      },
    );
  }

  throw new Error(`Token "${name}" did not resolve after 16 passes; check for a var() cycle`);
}

const OKLCH = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/;

/** Parse a fully resolved `oklch(...)` value, or return null for non-colour tokens. */
export function parseOklch(value: string): Oklch | null {
  const match = OKLCH.exec(value.trim());
  if (match === null) return null;

  const rawLightness = match[1] ?? '';
  const lightness = rawLightness.endsWith('%')
    ? Number(rawLightness.slice(0, -1)) / 100
    : Number(rawLightness);

  return { l: lightness, c: Number(match[2]), h: Number(match[3]) };
}
