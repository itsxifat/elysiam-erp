/**
 * Presence and the assignment engine (M41, D-713, D-716): who is working in the ERP now, and
 * who should be offered the next order or, from M42, the next conversation.
 *
 * Its own entry point (`@elysium/domain/assignment`) because the console reads the presence
 * thresholds and the work types too. Nothing here reaches a database.
 */
export {
  PRESENCE_AWAY_AFTER_MS,
  PRESENCE_BEAT_MS,
  PRESENCE_IDLE_AFTER_MS,
  PRESENCE_STATES,
  lastActiveFrom,
  presenceState,
  type PresenceFacts,
  type PresenceReading,
  type PresenceState,
} from './presence.js';

export {
  MAX_OPEN_DEFAULT,
  MAX_OPEN_MAX,
  MAX_OPEN_MIN,
  OFFER_SECONDS_DEFAULT,
  OFFER_SECONDS_MAX,
  OFFER_SECONDS_MIN,
  WORK_KINDS,
  WORK_TYPES,
  WORK_TYPE_FOR,
  defaultWorkTypes,
  ineligibility,
  pickAssignee,
  type AssignmentCandidate,
  type AssignmentInput,
  type Ineligibility,
  type WorkKind,
  type WorkType,
} from './engine.js';
