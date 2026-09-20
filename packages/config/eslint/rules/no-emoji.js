// Emoji are never UI elements in this product (CLAUDE.md UI rules, architecture
// §24). Icons come from lucide-react, and status is a label plus a token colour.
// `\p{Extended_Pictographic}` is the right property here: `\p{Emoji}` also
// matches digits, `#` and `*`, which would make the rule useless.
const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]/u;

/** @type {import('eslint').Rule.RuleModule} */
export const noEmoji = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow emoji characters in source strings; use a lucide-react icon instead.',
    },
    schema: [],
    messages: {
      emoji:
        'Emoji {{ char }} in source. Use a lucide-react icon, or a translated label, instead (CLAUDE.md UI rules).',
    },
  },
  create(context) {
    /**
     * @param {import('estree').Node} node
     * @param {string} text
     */
    function check(node, text) {
      const match = EMOJI.exec(text);
      if (match) {
        context.report({ node, messageId: 'emoji', data: { char: match[0] } });
      }
    }

    return {
      Literal(node) {
        if (typeof node.value === 'string') check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
};
