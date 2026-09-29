// Architecture §24 and M05 check 8: every colour comes from the tokens in
// packages/ui. A class that names a colour directly bypasses the theme, so it
// breaks dark mode and per-org branding (D-034) at the same time, and it does so
// silently: the Tailwind preset does not reset the default palette, so
// `bg-blue-500`, `bg-white` and `bg-[#fff]` all still compile to real CSS.
//
// This used to be a `no-restricted-syntax` selector that matched `bg-blue-500`
// only when it was a whole word inside a plain string literal. An audit found the
// forms it let through, and every one of them is a form people actually write:
//
//   bg-blue-500/50          the opacity modifier sat against the word boundary
//   hover:bg-blue-500       the regex needed whitespace before the utility
//   bg-white, text-black    not a palette shade, so never matched
//   bg-[#fff], text-[rgb()] an arbitrary value is a raw colour with extra steps
//   `bg-blue-500 ${x}`      a template literal is not a `Literal` node
//   `bg-${tone}-500`        a palette class assembled at runtime
//
// So the check is now a rule that tokenises each class string the way Tailwind
// does: strip the variants (`hover:`, `dark:`, `data-[state=open]:`), the
// important marker and the negative sign, then judge what is left. It looks at
// every string literal and every template literal in the file, which is what
// covers `className`, `cn()`, `clsx()` and `cva()` configs alike — a colour
// constant declared three lines above its use is exactly as broken as one
// written inline.

const PALETTES = [
  'slate',
  'gray',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  // Tailwind v4's additions. Each one compiles as happily as `blue`.
  'mauve',
  'olive',
  'mist',
  'taupe',
];

/**
 * Every utility that takes a colour. Longer names first is not required — the
 * regex is anchored at both ends, so `ring-offset-blue-500` backtracks from
 * `ring` to `ring-offset` — but it keeps the list readable as a table.
 */
const COLOUR_UTILITIES = [
  'bg',
  'text',
  'border',
  'border-x',
  'border-y',
  'border-t',
  'border-r',
  'border-b',
  'border-l',
  'border-s',
  'border-e',
  'ring',
  'ring-offset',
  'inset-ring',
  'from',
  'via',
  'to',
  'fill',
  'stroke',
  'shadow',
  'inset-shadow',
  'drop-shadow',
  'text-shadow',
  'outline',
  'decoration',
  'divide',
  'accent',
  'caret',
  'placeholder',
];

const UTILITY = `(?:${COLOUR_UTILITIES.join('|')})`;
const SHADE = String.raw`(?:${PALETTES.join('|')})-(?:50|[1-9]00|950)`;
const OPACITY = String.raw`(?:/(?:\d{1,3}|\[[^\]]+\]))?`;

/** `bg-blue-500`, `text-rose-950/40`, `border-x-white`, `ring-offset-black/[.3]`. */
const NAMED_COLOUR = new RegExp(`^${UTILITY}-(?:${SHADE}|black|white)${OPACITY}$`);

/** `bg-[#fff]`, `text-[rgb(0_0_0)]`, `shadow-[0_1px_2px_rgba(0,0,0,.1)]`. */
const ARBITRARY_VALUE = new RegExp(String.raw`^${UTILITY}-\[(.+)\]${OPACITY}$`);

/** `[color:#fff]`, `[background-color:rgb(0,0,0)]`: an arbitrary property. */
const ARBITRARY_PROPERTY = /^\[[a-z-]+:(.+)\]$/;

/**
 * A colour written as a literal: hex, or any CSS colour function.
 *
 * `(?<![a-z-])` rather than `\b` before the function name: Tailwind writes the
 * spaces of an arbitrary value as underscores, and `_` is a word character, so
 * `\b` finds no boundary in `0_1px_rgba(…)` and the shadow's colour walks past.
 */
const COLOUR_LITERAL =
  /#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z])|(?<![a-z-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/;

/** A quasi that ends mid-class, right before an interpolation: `bg-${`. */
const DANGLING_UTILITY = new RegExp(`(?:^|[\\s:!])${UTILITY}-$`);

/** …and the quasi after it carrying the shade: `}-500`. */
const TRAILING_SHADE = /^-(?:50|[1-9]00|950)(?:\/|\s|$)/;

/**
 * The part of a class that names the utility, with its variants removed.
 *
 * Variants are separated by `:`, but a colon inside brackets belongs to an
 * arbitrary value or property (`[color:#fff]`, `data-[state=open]:`), so the
 * split only counts colons at bracket depth zero.
 */
function utilityOf(token) {
  let depth = 0;
  let start = 0;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === '[') depth += 1;
    else if (char === ']') depth = Math.max(0, depth - 1);
    else if (char === ':' && depth === 0) start = index + 1;
  }
  let base = token.slice(start);
  // `!bg-red-500` (v3) and `bg-red-500!` (v4) are the same class, and a
  // negative value (`-mt-2`) is never a colour but is stripped for symmetry.
  if (base.startsWith('!')) base = base.slice(1);
  if (base.endsWith('!')) base = base.slice(0, -1);
  if (base.startsWith('-')) base = base.slice(1);
  return base;
}

/** Why a single class is a raw colour, or null when it is not one. */
function violation(token) {
  const base = utilityOf(token);
  if (base === '') return null;

  if (NAMED_COLOUR.test(base)) return 'palette';

  const arbitrary = ARBITRARY_VALUE.exec(base);
  if (arbitrary !== null && COLOUR_LITERAL.test(arbitrary[1] ?? '')) return 'arbitrary';

  const property = ARBITRARY_PROPERTY.exec(base);
  if (property !== null && COLOUR_LITERAL.test(property[1] ?? '')) return 'arbitrary';

  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noRawColour = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Tailwind classes that name a colour directly instead of a design token.',
    },
    schema: [],
    messages: {
      palette:
        'Raw Tailwind colour "{{ token }}". Use a semantic token class (bg-primary, text-muted-foreground, border-border) so dark mode and per-org branding keep working.',
      arbitrary:
        'Arbitrary colour "{{ token }}". Colours come from the tokens in packages/ui; add a token rather than writing the value.',
      dynamic:
        'A palette class assembled at runtime ("{{ token }}…"). Map the state to a semantic token class instead, so every possible value is a token.',
    },
  },
  create(context) {
    /**
     * Report every raw colour in one run of class text.
     *
     * `partialStart` and `partialEnd` mark text glued to an interpolation on that
     * side: `${x}bg-red` and `bg-${x}` are fragments of a class, not classes, and
     * judging them alone would report `bg-` as a utility with no value.
     */
    function check(node, text, partialStart, partialEnd) {
      const tokens = text.split(/\s+/);
      tokens.forEach((token, index) => {
        if (token === '') return;
        if (partialStart && index === 0) return;
        if (partialEnd && index === tokens.length - 1) return;
        const messageId = violation(token);
        if (messageId !== null) context.report({ node, messageId, data: { token } });
      });
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value, false, false);
      },
      TemplateLiteral(node) {
        const { quasis } = node;
        quasis.forEach((quasi, index) => {
          const text = quasi.value.cooked ?? quasi.value.raw;
          const hasBefore = index > 0 && !/^\s/.test(text);
          const hasAfter = index < quasis.length - 1 && !/\s$/.test(text);
          check(quasi, text, hasBefore, hasAfter);

          // `bg-${tone}-500`: the colour is chosen at runtime, so no static
          // value is ever visible — but the shade after the hole says a
          // palette colour is going in it.
          const next = quasis[index + 1];
          if (next === undefined) return;
          const dangling = DANGLING_UTILITY.exec(text);
          const nextText = next.value.cooked ?? next.value.raw;
          if (dangling !== null && TRAILING_SHADE.test(nextText)) {
            context.report({
              node: quasi,
              messageId: 'dynamic',
              data: { token: dangling[0].trim().replace(/^[:!]/, '') },
            });
          }
        });
      },
    };
  },
};
