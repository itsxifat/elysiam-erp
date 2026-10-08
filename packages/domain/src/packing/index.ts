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
  cameraBufferKeepFromMs,
  cameraParts,
  cameraReconnectDelayMs,
  cameraRecordingFrom,
  cameraRecordingTimedOut,
  cameraRecordingTo,
  cameraState,
  cutDecision,
  cutSpan,
  segmentsForWindow,
  segmentsToForget,
  windowCoverage,
  type CameraSegment,
  type CameraState,
} from './camera.js';
