/**
 * Staff → super admins made and removed at once (D-954; D-607's pattern): the English section, shipped with the Staff screen rather
 * than in the first download. No string names a brand (M31).
 */
const en = {
  'users.superAdminHeading': 'Super admin',
  'users.superAdminExplain':
    'A super admin holds every power in the ERP, approves any request and must use two-step sign-in.',
  'users.superAdminImmediate': 'This takes effect at once.',
  'users.superAdminMake': 'Make super admin',
  'users.superAdminConfirm': 'Make {name} a super admin?',
  'users.superAdminPromoted': '{name} is a super admin now.',
  'users.removalStart': 'Remove super admin',
  'users.stepDown': 'Step down',
  'users.removalTitle': 'Remove {name} as a super admin?',
  'users.removalImmediate':
    'They lose super admin power at once and are signed out. An admin role they hold in this brand stays.',
  'users.stepDownTitle': 'Step down as super admin?',
  'users.stepDownDetail':
    'You lose super admin power at once and are signed out. An admin role you hold in this brand stays.',
  'users.removalDone': '{name} is no longer a super admin.',
  'users.inviteSuperAdmin': 'Invite a super admin',
  'users.inviteSuperAdminDetail':
    'They join as an admin, are a super admin at once and must set up two-step sign-in.',
} as const;

/** The keys of this section. */
export type TrustKey = keyof typeof en;

export { en };
