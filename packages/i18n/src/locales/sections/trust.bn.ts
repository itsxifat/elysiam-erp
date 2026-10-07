import type { TrustKey } from './trust.en.js';

/**
 * Staff → trust votes (D-654 to D-656): the Bangla section, typed against the English one, so
 * a key on one side only does not compile.
 */
const bn: Record<TrustKey, string> = {
  'users.trusted': 'বিশ্বস্ত',
  'users.trustVotes': '{m}টির মধ্যে {n}টি ভোট',
  'users.trustHeading': 'আস্থা',
  'users.trustExplain':
    'বিশ্বস্ত অ্যাডমিন তাঁকে আমন্ত্রণ জানানো অ্যাডমিনের অনুরোধও অনুমোদন করতে পারেন; নিজের অনুরোধ কেউ অনুমোদন করতে পারেন না।',
  'users.trustRule':
    'তাঁর আমন্ত্রণ-শৃঙ্খলের বাইরের অ্যাডমিনদের দুই-তৃতীয়াংশকে ভোট দিতে হবে, আর কখনোই দুজনের কম নয়।',
  'users.trustVote': 'আস্থা দিন',
  'users.trustWithdraw': 'আস্থা প্রত্যাহার করুন',
  'users.trustReason.self': 'কেউ নিজের পক্ষে ভোট দিতে পারেন না।',
  'users.trustReason.not_admin': 'শুধু সক্রিয় অ্যাডমিন ভোট দিতে পারেন।',
  'users.trustReason.no_two_factor': 'ভোট দিতে টু-স্টেপ ভেরিফিকেশন চালু করুন।',
  'users.trustReason.invited_candidate': 'আপনি এই ব্যক্তিকে আমন্ত্রণ জানিয়েছেন।',
  'users.trustReason.invited_by_candidate': 'এই ব্যক্তি আপনাকে আমন্ত্রণ জানিয়েছেন।',
  'users.trustReason.same_inviter': 'আপনাদের দুজনকেই একই ব্যক্তি আমন্ত্রণ জানিয়েছেন।',
};

export { bn };
