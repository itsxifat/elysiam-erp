// Architecture §24: styling is Tailwind utilities over the design tokens, never
// an inline style object. CSS custom properties are the one exception, because
// per-org theming (D-034) sets `--brand-h` and `--brand-c` at runtime and that
// is the mechanic that lets five brands share one design system.

/** @type {import('eslint').Rule.RuleModule} */
export const noInlineStyle = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow inline style objects. Only CSS custom properties (--*) may be set inline.',
    },
    schema: [],
    messages: {
      inlineStyle:
        'Inline style "{{ prop }}" is not allowed. Use Tailwind utilities over the tokens in packages/ui. Only CSS custom properties (--*) may be set inline.',
      dynamicStyle:
        'This style value cannot be checked statically. Use Tailwind utilities, or inline an object literal of CSS custom properties (--*) only.',
    },
  },
  create(context) {
    return {
      'JSXAttribute[name.name="style"]'(node) {
        const value = node.value;
        if (!value || value.type !== 'JSXExpressionContainer') {
          context.report({ node, messageId: 'dynamicStyle' });
          return;
        }

        const expression = value.expression;
        if (expression.type !== 'ObjectExpression') {
          context.report({ node, messageId: 'dynamicStyle' });
          return;
        }

        for (const property of expression.properties) {
          if (property.type === 'SpreadElement') {
            context.report({ node: property, messageId: 'dynamicStyle' });
            continue;
          }

          const key = property.key;
          let name = null;
          if (!property.computed && key.type === 'Identifier') name = key.name;
          else if (key.type === 'Literal' && typeof key.value === 'string') name = key.value;

          if (name === null) {
            context.report({ node: property, messageId: 'dynamicStyle' });
          } else if (!name.startsWith('--')) {
            context.report({ node: property, messageId: 'inlineStyle', data: { prop: name } });
          }
        }
      },
    };
  },
};
