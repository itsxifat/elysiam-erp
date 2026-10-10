/**
 * Staff → trust votes (D-654 to D-657) and super admins making and removing super admins
 * (D-659, D-685; D-607's pattern): the English section, shipped with the Staff screen rather
 * than in the first download. No string names a brand (M31).
 */
const en = {
  'users.trusted': 'Trusted',
  'users.trustVotes': '{n} of {m} votes',
  'users.trustHeading': 'Trust',
  'users.trustExplain':
    'Trusted admins can approve requests from the admin who invited them; nobody approves their own.',
  'users.trustRule':
    "Two thirds of the admins outside their invitation chain must vote, and never fewer than two. A super admin's vote is enough on its own.",
  'users.trustVote': 'Trust',
  'users.trustWithdraw': 'Withdraw trust',
  'users.trustReason.self': 'Nobody vouches for themselves.',
  'users.trustReason.not_admin': 'Only an active admin can vote.',
  'users.trustReason.no_two_factor': 'Turn on two-step sign-in to vote.',
  'users.trustReason.invited_candidate': 'You invited this person.',
  'users.trustReason.invited_by_candidate': 'This person invited you.',
  'users.trustReason.same_inviter': 'You were both invited by the same person.',
  'users.superAdminHeading': 'Super admin',
  'users.superAdminExplain':
    'A super admin holds every power in the ERP, approves any request and must use two-step sign-in.',
  'users.superAdminImmediate': 'There is one super admin now, so this takes effect at once.',
  'users.superAdminRule':
    'There are {m} super admins. Every one of them must vote yes before this person becomes one.',
  'users.superAdminPending': 'Super admin: {n} of {m} votes',
  'users.superAdminMake': 'Make super admin',
  'users.superAdminVote': 'Vote yes',
  'users.superAdminVoted': 'You have voted yes.',
  'users.superAdminWithdraw': 'Withdraw nomination',
  'users.superAdminOnlyNote': 'Only a super admin can make a super admin.',
  'users.superAdminConfirm': 'Make {name} a super admin?',
  'users.superAdminPromoted': '{name} is a super admin now.',
  'users.superAdminWaiting': '{name} becomes a super admin once every super admin has voted yes.',
  'users.superAdminWithdrawn': 'The nomination was withdrawn.',
  'users.removalPending': 'Removal: {n} of {m} votes',
  'users.removalStart': 'Remove super admin',
  'users.removalVote': 'Vote to remove',
  'users.removalWithdraw': 'Withdraw removal',
  'users.stepDown': 'Step down',
  'users.removalTitle': 'Remove {name} as a super admin?',
  'users.removalVoteTitle': 'Vote to remove {name} as a super admin?',
  'users.removalImmediate':
    'They lose super admin power at once and are signed out. An admin role they hold in this brand stays.',
  'users.removalRule':
    'Every other super admin must vote yes ({m} votes). They keep super admin power until then, and are signed out once removed.',
  'users.removalWithdrawTitle': 'Withdraw the removal of {name}?',
  'users.removalWithdrawDetail':
    'Every vote for it is cleared. Only the first super admin can start it again.',
  'users.stepDownTitle': 'Step down as super admin?',
  'users.stepDownDetail':
    'You lose super admin power at once and are signed out. An admin role you hold in this brand stays.',
  'users.removalDone': '{name} is no longer a super admin.',
  'users.removalWaiting': '{name} is removed once every other super admin has voted yes.',
  'users.removalWithdrawn': 'The removal was withdrawn.',
  'users.inviteSuperAdmin': 'Invite a super admin',
  'users.inviteSuperAdminDetail':
    'They join as an admin and must set up two-step sign-in. With one super admin they are a super admin at once; with more, the others vote first.',
} as const;

/** The keys of this section. */
export type TrustKey = keyof typeof en;

export { en };
