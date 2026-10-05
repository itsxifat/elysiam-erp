/**
 * Barcodes, stickers and scanning (M38a, D-603 to D-605).
 *
 * Its own entry point (`@elysium/domain/barcode`) because the console uses it too: the
 * scanner detection runs in the browser, and the product page draws each variant's
 * barcode. Nothing here imports anything, so the console's bundle carries only these few
 * functions, never the rest of the domain package.
 */
export {
  EAN13_INTERNAL_PREFIX,
  EAN13_MAX_SEQUENCE,
  EAN13_MODULES,
  EAN13_PATTERNS,
  EAN13_QUIET_LEFT,
  EAN13_QUIET_RIGHT,
  EAN13_TOTAL_MODULES,
  Ean13Error,
  ean13CheckDigit,
  ean13Modules,
  ean13Svg,
  internalEan13,
  internalEan13Sequence,
  isInternalEan13,
  isValidEan13,
  type Ean13SvgOptions,
} from './ean13.js';

export {
  DEFAULT_SCAN_OPTIONS,
  createScanDetector,
  detectScans,
  normaliseScannedCode,
  type ScanDetector,
  type ScanKey,
  type ScanOptions,
  type ScanStep,
} from './scan.js';

export {
  MAX_STICKERS_PER_PDF,
  STICKER_MEDIA,
  STICKER_MEDIA_IDS,
  StickerLayoutError,
  fitStickerText,
  isStickerMedium,
  stickerPageSize,
  stickerPages,
  stickerParts,
  stickersPerPage,
  type RollMedium,
  type SheetMedium,
  type StickerMedium,
  type StickerMediumSpec,
} from './stickers.js';
