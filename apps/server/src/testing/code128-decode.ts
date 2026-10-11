import { CODE128_PATTERNS } from '@elysium/domain';

/**
 * Read a Code 128 barcode back out of the SVG `code128Svg` draws, the way a scanner reads the
 * printed bars (M43): bar and space widths in modules, six elements a symbol, the start code,
 * the data, the check character and the stop. Test-only — the point is that what a document
 * prints is what the packing station is then given, decoded from the bars rather than taken
 * from the text printed under them.
 *
 * Subset B only, which is all the encoder writes; anything else is a failure, not a guess.
 */
export function decodeCode128Svg(svg: string): string {
  const bars = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map((match) => ({
    x: Number(match[1]),
    width: Number(match[2]),
  }));
  if (bars.length === 0) throw new Error('no bars in that SVG');

  // Alternating bar and space widths, starting and ending with a bar.
  const widths: number[] = [];
  bars.forEach((bar, index) => {
    widths.push(bar.width);
    const next = bars[index + 1];
    if (next !== undefined) widths.push(next.x - (bar.x + bar.width));
  });

  const stop = CODE128_PATTERNS[106] ?? '';
  if (widths.slice(-7).join('') !== stop) throw new Error('the symbol does not end in a stop');
  const symbols = widths.slice(0, -7);
  if (symbols.length % 6 !== 0) throw new Error('the bars are not whole symbols');

  const values: number[] = [];
  for (let at = 0; at < symbols.length; at += 6) {
    const value = CODE128_PATTERNS.indexOf(symbols.slice(at, at + 6).join(''));
    if (value < 0) throw new Error(`no Code 128 symbol at element ${String(at)}`);
    values.push(value);
  }

  const [start, ...rest] = values;
  if (start !== 104) throw new Error('not a subset B symbol');
  const check = rest.pop();
  const data = rest;
  const sum = data.reduce((total, value, index) => total + value * (index + 1), 104);
  if (check !== sum % 103) throw new Error('the check character does not match');
  return data.map((value) => String.fromCharCode(value + 32)).join('');
}
