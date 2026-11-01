/**
 * Scan-to-pack and the packing video (M38b, D-610 to D-612), and the IP camera that films the
 * packing table (M38c, D-668 to D-676).
 *
 * Its own entry point (`@elysium/domain/packing`) because the console uses the scan rules too:
 * the packing station shows each line's progress with the function the server judges by.
 * Nothing here reaches a database.
 */
export {
  PACK_SCAN_OUTCOMES,
  PACK_SCAN_REFUSALS,
  isPackScanRefusal,
  judgePackRemoval,
  judgePackScan,
  packNeeds,
  packProgress,
  packedCounts,
  type PackLineProgress,
  type PackLineState,
  type PackNeed,
  type PackOrderLine,
  type PackProgress,
  type PackScanOutcome,
  type PackScanRefusal,
  type RecordedPackScan,
  type ScannedSku,
} from './scan.js';

export {
  PACKING_VIDEO_KEEP_DAYS,
  PACKING_VIDEO_RETENTION_REASONS,
  isPackingVideoExpired,
  packingVideoExpiry,
  type PackingVideoExpiry,
  type PackingVideoOrderFacts,
  type PackingVideoRetentionReason,
} from './retention.js';

export {
  PACKING_VIDEO_GRACE_MS,
  packingVideoState,
  type PackingVideoPartFacts,
  type PackingVideoState,
} from './video-state.js';

export {
  PACKING_CAMERA_CUT_WAIT_MS,
  PACKING_CAMERA_HORIZON_MS,
  PACKING_CAMERA_LIVE_MS,
  PACKING_CAMERA_MAX_MS,
  PACKING_CAMERA_PREROLL_MS,
  PACKING_CAMERA_READY_WITHIN_MS,
  PACKING_CAMERA_TAIL_MS,
  PACKING_PREVIEW_DEMAND_MS,
  PACKING_PREVIEW_FRESH_MS,
  PACKING_PREVIEW_LINGER_MS,
  PACKING_PREVIEW_RENEW_BELOW_MS,
  cameraBufferKeepFromMs,
  cameraParts,
  cameraReconnectDelayMs,
  cameraRecordingFrom,
  cameraRecordingTimedOut,
  cameraRecordingTo,
  cameraState,
  cutDecision,
  cutSpan,
  previewDemandUntil,
  previewFrameFresh,
  previewShouldRun,
  segmentsForWindow,
  segmentsOverByteCap,
  segmentsToForget,
  windowCoverage,
  type CameraSegment,
  type CameraState,
} from './camera.js';

// M46: lots (D-805 to D-808) and the print queue (D-813 to D-819).
export {
  LOT_COUNT_MAX,
  handoverComplete,
  handoverMissing,
  judgeConfirmLots,
  judgeHandoverScan,
  judgeLotClose,
  judgeLotCount,
  judgeLotFinish,
  lotCode,
  lotCountLimit,
  openLot,
  parseLotCode,
  piecesByLot,
  type HandoverScanOutcome,
  type LotCloseRefusal,
  type LotCountRefusal,
  type LotFinishRefusal,
} from './lots.js';
export {
  LOT_SCAN_DIGITS,
  ORDER_SCAN_DIGITS,
  lotScanCode,
  orderScanCode,
  parseLotScanCode,
  parseOrderScanCode,
  readLotCode,
  scannedOrderParts,
} from './scan-code.js';

// M51: label to label, the pause after the idle time, one video per lot, returns (D-930 to D-936).
export {
  PACKING_IDLE_PAUSE_DEFAULT_MS,
  PACKING_IDLE_PAUSE_MAX_MS,
  PACKING_IDLE_PAUSE_MIN_MS,
  PACKING_LABEL_REREAD_MS,
  PACKING_RESUME_LEAD_MS,
  PACKING_RETURN_VIDEO_KEEP_DAYS,
  isLabelReread,
  judgePackLabelScan,
  judgeReturnLabelScan,
  pauseInMs,
  readOrderLabel,
  recordedMs,
  recordingPaused,
  recordingSpans,
  recordingStopAt,
  recordingTimedOut,
  returnVideoExpiry,
  type LabelRefusal,
  type LabelVerdict,
  type RecordingSpan,
} from './recording.js';

export {
  PRINTER_STATUS_FRESH_MS,
  PRINT_JOB_STATES,
  PRINT_MAX_ATTEMPTS,
  PRINT_SENDING_STALE_MS,
  STATION_SEEN_MS,
  isOpenPrintJob,
  isReprint,
  ordersPerHour,
  pickTerminal,
  printJobAfter,
  printSummary,
  printerOnline,
  printerShownState,
  type PrintJobEvent,
  type PrintJobState,
  type PrintRecord,
  type PrinterState,
  type TerminalCandidate,
} from './printing.js';
