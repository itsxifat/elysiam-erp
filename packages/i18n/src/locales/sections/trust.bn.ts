import type { TrustKey } from './trust.en.js';

/**
 * Staff → trust votes (D-654 to D-657) and super admins making super admins (D-659): the
 * Bangla section, typed against the English one, so a key on one side only does not compile.
 */
const bn: Record<TrustKey, string> = {
  'users.trusted': 'বিশ্বস্ত',
  'users.trustVotes': '{m}টির মধ্যে {n}টি ভোট',
  'users.trustHeading': 'আস্থা',
  'users.trustExplain':
    'বিশ্বস্ত অ্যাডমিন তাঁকে আমন্ত্রণ জানানো অ্যাডমিনের অনুরোধও অনুমোদন করতে পারেন; নিজের অনুরোধ কেউ অনুমোদন করতে পারেন না।',
  'users.trustRule':
    'তাঁর আমন্ত্রণ-শৃঙ্খলের বাইরের অ্যাডমিনদের দুই-তৃতীয়াংশকে ভোট দিতে হবে, আর কখনোই দুজনের কম নয়। একজন সুপার অ্যাডমিনের ভোটই যথেষ্ট।',
  'users.trustVote': 'আস্থা দিন',
  'users.trustWithdraw': 'আস্থা প্রত্যাহার করুন',
  'users.trustReason.self': 'কেউ নিজের পক্ষে ভোট দিতে পারেন না।',
  'users.trustReason.not_admin': 'শুধু সক্রিয় অ্যাডমিন ভোট দিতে পারেন।',
  'users.trustReason.no_two_factor': 'ভোট দিতে টু-স্টেপ ভেরিফিকেশন চালু করুন।',
  'users.trustReason.invited_candidate': 'আপনি এই ব্যক্তিকে আমন্ত্রণ জানিয়েছেন।',
  'users.trustReason.invited_by_candidate': 'এই ব্যক্তি আপনাকে আমন্ত্রণ জানিয়েছেন।',
  'users.trustReason.same_inviter': 'আপনাদের দুজনকেই একই ব্যক্তি আমন্ত্রণ জানিয়েছেন।',
  'users.superAdminHeading': 'সুপার অ্যাডমিন',
  'users.superAdminExplain':
    'সুপার অ্যাডমিন ইআরপির সব ক্ষমতা রাখেন, যেকোনো অনুরোধ অনুমোদন করতে পারেন এবং তাঁকে টু-স্টেপ সাইন-ইন ব্যবহার করতে হয়।',
  'users.superAdminImmediate': 'এখন একজন সুপার অ্যাডমিন আছেন, তাই এটি সঙ্গে সঙ্গে কার্যকর হবে।',
  'users.superAdminRule':
    'এখন {m} জন সুপার অ্যাডমিন আছেন। এই ব্যক্তি সুপার অ্যাডমিন হওয়ার আগে তাঁদের প্রত্যেককে হ্যাঁ ভোট দিতে হবে।',
  'users.superAdminPending': 'সুপার অ্যাডমিন: {m}টির মধ্যে {n}টি ভোট',
  'users.superAdminMake': 'সুপার অ্যাডমিন করুন',
  'users.superAdminVote': 'হ্যাঁ ভোট দিন',
  'users.superAdminVoted': 'আপনি হ্যাঁ ভোট দিয়েছেন।',
  'users.superAdminWithdraw': 'মনোনয়ন প্রত্যাহার করুন',
  'users.superAdminOnlyNote': 'শুধু একজন সুপার অ্যাডমিনই কাউকে সুপার অ্যাডমিন করতে পারেন।',
  'users.superAdminConfirm': '{name}-কে সুপার অ্যাডমিন করবেন?',
  'users.superAdminPromoted': '{name} এখন সুপার অ্যাডমিন।',
  'users.superAdminWaiting': 'সব সুপার অ্যাডমিন হ্যাঁ ভোট দিলে {name} সুপার অ্যাডমিন হবেন।',
  'users.superAdminWithdrawn': 'মনোনয়ন প্রত্যাহার করা হয়েছে।',
  'users.inviteSuperAdmin': 'সুপার অ্যাডমিন আমন্ত্রণ করুন',
  'users.inviteSuperAdminDetail':
    'তিনি অ্যাডমিন হিসেবে যোগ দেবেন এবং তাঁকে টু-স্টেপ সাইন-ইন চালু করতে হবে। একজন সুপার অ্যাডমিন থাকলে তিনি সঙ্গে সঙ্গে সুপার অ্যাডমিন হবেন; বেশি থাকলে অন্যরা আগে ভোট দেবেন।',
};

export { bn };
