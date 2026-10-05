import {
  EAN13_DIGIT_BAND_MODULES,
  EAN13_QUIET_LEFT,
  PT_TO_MM,
  ean13Modules,
  fitStickerText,
  internalEan13,
  type StickerLayout,
} from '@elysium/domain/barcode';
import { useId } from 'react';

/**
 * One sticker drawn from the layout the PDF is drawn from (D-650), so what the dialog shows
 * is what the printer gets: the same rows at the same places, the same bars, the same lines
 * given up on a small sticker. Units are millimetres in the viewBox; the type is the
 * sticker's own, in points turned to millimetres.
 *
 * Drawn in the theme's tokens (a card with the foreground as ink), not in black on white,
 * so it reads as part of the console in both themes. The barcode is a sample: the dialog
 * may print many variants, each with its own.
 */

/** A sample internal EAN-13, for the bars and digits of the preview. */
const SAMPLE_CODE = internalEan13(1);

/** Where a line of text sits in its row: its baseline, from the row's top. */
function baseline(rowY: number, lineHeightMm: number, fontMm: number, line = 0): number {
  return rowY + line * lineHeightMm + (lineHeightMm - fontMm) / 2 + fontMm * 0.8;
}

/** Up to `lines` lines of about `perLine` characters, words kept whole where they can be. */
function wrap(text: string, perLine: number, lines: number): string[] {
  const fitted = fitStickerText(text, perLine * lines);
  if (lines <= 1) return [fitted];
  const out: string[] = [];
  let current = '';
  for (const word of fitted.split(' ')) {
    const next = current === '' ? word : `${current} ${word}`;
    if ([...next].length <= perLine || current === '') current = next;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current !== '') out.push(current);
  if (out.length <= lines) return out;
  return [...out.slice(0, lines - 1), fitStickerText(out.slice(lines - 1).join(' '), perLine)];
}

export interface StickerPreviewText {
  readonly brand: string;
  readonly price: string | null;
  readonly name: string;
  readonly variant: string;
  readonly code: string;
  readonly extra: string | null;
}

export function StickerPreview({
  layout,
  text,
  label,
}: {
  readonly layout: StickerLayout;
  readonly text: StickerPreviewText;
  /** What a screen reader hears: the size and what is on it. */
  readonly label: string;
}) {
  // A plain id: React's own carries characters a `url(#…)` reference may not take.
  const clip = `sticker-clip-${useId().replace(/[^\w-]/g, '')}`;
  const { scale, widthMm, heightMm, padXMm, moduleMm, barModules } = layout;
  // About 6 px a millimetre on the smallest rolls, less on a big sticker, so it fits.
  const pxPerMm = Math.min(6, 228 / Math.max(widthMm, heightMm));
  const rightX = widthMm - padXMm;

  const modules = ean13Modules(SAMPLE_CODE);
  const bars: { x: number; w: number; guard: boolean }[] = [];
  for (let index = 0; index < modules.length;) {
    if (modules[index] !== '1') {
      index += 1;
      continue;
    }
    let end = index;
    while (end < modules.length && modules[end] === '1') end += 1;
    const guard = index < 3 || (index >= 45 && index < 50) || index >= 92;
    bars.push({ x: index, w: end - index, guard });
    index = end;
  }

  const rows = layout.rows.map((row) => {
    switch (row.kind) {
      case 'top': {
        const brandMm = scale.brand * PT_TO_MM;
        const priceMm = scale.price * PT_TO_MM;
        const tallest = text.price === null ? brandMm : priceMm;
        const y = baseline(row.yMm, row.heightMm, tallest);
        // The brand gives way to the price, as the PDF's ellipsis does: about 0.6 em a
        // character for the price, 0.7 em for the spaced capitals of the brand.
        const priceWidth = text.price === null ? 0 : [...text.price].length * 0.6 * priceMm + 1;
        const brandChars = Math.max(
          3,
          Math.min(24, Math.floor((layout.innerWidthMm - priceWidth) / (0.7 * brandMm))),
        );
        return (
          <g key="top" fontWeight={600}>
            <text x={padXMm} y={y} fontSize={brandMm} letterSpacing={brandMm * 0.04}>
              {fitStickerText(text.brand, brandChars).toUpperCase()}
            </text>
            {text.price === null ? null : (
              <text x={rightX} y={y} fontSize={priceMm} textAnchor="end">
                {text.price}
              </text>
            )}
          </g>
        );
      }
      case 'name': {
        const fontMm = scale.name * PT_TO_MM;
        const lineMm = row.heightMm / Math.max(1, layout.nameLines);
        return (
          <g key="name" fontSize={fontMm}>
            {wrap(text.name, layout.chars.name, layout.nameLines).map((line, index) => (
              <text key={String(index)} x={padXMm} y={baseline(row.yMm, lineMm, fontMm, index)}>
                {line}
              </text>
            ))}
          </g>
        );
      }
      case 'variant': {
        const fontMm = scale.variant * PT_TO_MM;
        return (
          <text
            key="variant"
            x={padXMm}
            y={baseline(row.yMm, row.heightMm, fontMm)}
            fontSize={fontMm}
            fontWeight={600}
          >
            {fitStickerText(text.variant, layout.chars.variant)}
          </text>
        );
      }
      case 'extra': {
        const fontMm = scale.extra * PT_TO_MM;
        return (
          <text
            key="extra"
            x={padXMm}
            y={baseline(row.yMm, row.heightMm, fontMm)}
            fontSize={fontMm}
          >
            {fitStickerText(text.extra ?? '', layout.chars.extra)}
          </text>
        );
      }
      case 'symbol': {
        // Module units inside, like ean13Svg: quiet zone, bars, longer guards, the digits.
        const digit = (x: number, value: string, index: number) => (
          <text key={String(index)} x={x} y={barModules + 9} fontSize={9} textAnchor="middle">
            {value}
          </text>
        );
        const digits = [digit(EAN13_QUIET_LEFT - 5, SAMPLE_CODE.charAt(0), 0)];
        for (let index = 0; index < 6; index += 1) {
          digits.push(
            digit(EAN13_QUIET_LEFT + 3 + index * 7 + 3.5, SAMPLE_CODE.charAt(1 + index), 1 + index),
            digit(
              EAN13_QUIET_LEFT + 50 + index * 7 + 3.5,
              SAMPLE_CODE.charAt(7 + index),
              7 + index,
            ),
          );
        }
        return (
          <g
            key="symbol"
            transform={`translate(${String(layout.symbolXMm)} ${String(row.yMm)}) scale(${String(moduleMm)})`}
            shapeRendering="crispEdges"
          >
            {bars.map((bar) => (
              <rect
                key={String(bar.x)}
                x={EAN13_QUIET_LEFT + bar.x}
                y={0}
                width={bar.w}
                height={bar.guard ? barModules + EAN13_DIGIT_BAND_MODULES / 2 : barModules}
              />
            ))}
            {digits}
          </g>
        );
      }
      case 'code': {
        const fontMm = scale.code * PT_TO_MM;
        return (
          <text
            key="code"
            x={widthMm / 2}
            y={baseline(row.yMm, row.heightMm, fontMm)}
            fontSize={fontMm}
            textAnchor="middle"
            letterSpacing={fontMm * 0.03}
          >
            {text.code}
          </text>
        );
      }
    }
  });

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(widthMm)} ${String(heightMm)}`}
      width={Math.round(widthMm * pxPerMm)}
      height={Math.round(heightMm * pxPerMm)}
      className="max-w-full fill-foreground tabular-nums"
      data-testid="sticker-preview"
    >
      <defs>
        <clipPath id={clip}>
          <rect x={0} y={0} width={widthMm} height={heightMm} rx={0.8} />
        </clipPath>
      </defs>
      <rect
        x={0}
        y={0}
        width={widthMm}
        height={heightMm}
        rx={0.8}
        className="fill-card stroke-border"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      <g clipPath={`url(#${clip})`}>{rows}</g>
    </svg>
  );
}
