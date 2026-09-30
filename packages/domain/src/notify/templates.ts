/**
 * Message templates (architecture §10): `{name}` placeholders filled from named
 * values, in bn or en.
 *
 * A template that names a value the caller did not give is refused rather than sent
 * with `{code}` in it: a buyer who receives "your code is {code}" has been sent a
 * broken promise, and the send log would record it as delivered.
 */

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

export class TemplateError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`The template needs ${missing.join(', ')}, which were not given.`);
    this.name = 'TemplateError';
  }
}

export function placeholdersOf(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))];
}

export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  const missing = placeholdersOf(template).filter((name) => values[name] === undefined);
  if (missing.length > 0) throw new TemplateError(missing);
  return template.replace(PLACEHOLDER, (_, name: string) => values[name] ?? '');
}

/** A GSM-7 SMS carries 160 characters; any Bangla makes it UCS-2, which carries 70. */
export function smsSegments(text: string): number {
  // eslint-disable-next-line no-control-regex
  const unicode = /[^\u0000-\u007f]/.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const length = [...text].length;
  return length <= single ? 1 : Math.ceil(length / multi);
}
