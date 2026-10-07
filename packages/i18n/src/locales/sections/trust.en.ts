/**
 * Staff → trust votes (D-654 to D-656; D-607's pattern): the English section, shipped with the
 * Staff screen rather than in the first download. No string names a brand (M31).
 */
const en = {
  'users.trusted': 'Trusted',
  'users.trustVotes': '{n} of {m} votes',
  'users.trustHeading': 'Trust',
  'users.trustExplain':
    'Trusted admins can approve requests from the admin who invited them; nobody approves their own.',
  'users.trustRule':
    'Two thirds of the admins outside their invitation chain must vote, and never fewer than two.',
  'users.trustVote': 'Trust',
  'users.trustWithdraw': 'Withdraw trust',
  'users.trustReason.self': 'Nobody vouches for themselves.',
  'users.trustReason.not_admin': 'Only an active admin can vote.',
  'users.trustReason.no_two_factor': 'Turn on two-step sign-in to vote.',
  'users.trustReason.invited_candidate': 'You invited this person.',
  'users.trustReason.invited_by_candidate': 'This person invited you.',
  'users.trustReason.same_inviter': 'You were both invited by the same person.',
} as const;

/** The keys of this section. */
export type TrustKey = keyof typeof en;

export { en };
