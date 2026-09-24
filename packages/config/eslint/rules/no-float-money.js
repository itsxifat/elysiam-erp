// Money is integer poisha (CLAUDE.md invariant 1, architecture §7). The two
// usual ways a float sneaks into an amount are `parseFloat('12.34') * 100` on
// the way in and `(x / 100).toFixed(2)` on the way out, and both round in
// binary floating point. Rounding and parsing live in
// `packages/domain/src/money`, which is the one place this rule is switched
// off (see packages/domain/eslint.config.js). Anything else that genuinely is
// not money — a contrast ratio, a benchmark timing — says so with an
// `eslint-disable-next-line elysium/no-float-money -- <why>` comment.

/** @type {import('eslint').Rule.RuleModule} */
export const noFloatMoney = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow toFixed() and parseFloat() outside packages/domain/src/money; money is integer poisha.',
    },
    schema: [],
    messages: {
      toFixed:
        '`.toFixed()` rounds in binary floating point. Format money with formatMoney() from @elysium/i18n, and round with the helpers in packages/domain/src/money.',
      parseFloat:
        '`parseFloat` produces a float. Parse money with parseTaka()/parsePoisha() from packages/domain/src/money.',
    },
  },
  create(context) {
    /** @param {import('estree').Node} node */
    function propertyName(node) {
      if (node.type !== 'MemberExpression') return null;
      if (!node.computed && node.property.type === 'Identifier') return node.property.name;
      if (node.computed && node.property.type === 'Literal') return String(node.property.value);
      return null;
    }

    return {
      CallExpression(node) {
        const name = propertyName(node.callee);
        if (name === 'toFixed') context.report({ node, messageId: 'toFixed' });
      },
      // Every reference to parseFloat, called or not: `parseFloat(x)`,
      // `Number.parseFloat(x)`, `['12'].map(parseFloat)` and
      // `const f = parseFloat` are the same float by different routes.
      Identifier(node) {
        if (node.name !== 'parseFloat') return;
        // An object key or method named parseFloat is a name, not a use.
        const parent = /** @type {{ parent?: import('estree').Node }} */ (node).parent;
        if (
          (parent?.type === 'Property' || parent?.type === 'MethodDefinition') &&
          parent.key === node &&
          !parent.computed
        ) {
          return;
        }
        context.report({ node, messageId: 'parseFloat' });
      },
      Literal(node) {
        // `Number['parseFloat'](x)`.
        if (node.value !== 'parseFloat') return;
        const parent = /** @type {{ parent?: import('estree').Node }} */ (node).parent;
        if (parent?.type === 'MemberExpression' && parent.computed && parent.property === node) {
          context.report({ node, messageId: 'parseFloat' });
        }
      },
    };
  },
};
