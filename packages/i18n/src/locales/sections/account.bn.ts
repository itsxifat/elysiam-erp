import type { AccountKey } from './account.en.js';

/**
 * My account, Settings → Security and the Staff screen's sign-out and turn-off (M40): the
 * Bangla section, typed against the English one, so a key on one side only does not compile.
 */
const bn: Record<AccountKey, string> = {
  'account.title': 'আমার অ্যাকাউন্ট',
  'account.subtitle':
    'আপনার নাম, পাসওয়ার্ড, টু-স্টেপ সাইন-ইন এবং যেসব ডিভাইসে আপনি সাইন ইন করে আছেন।',
  'account.loading': 'আপনার অ্যাকাউন্ট লোড হচ্ছে',
  'account.errorTitle': 'আপনার অ্যাকাউন্ট লোড করা যায়নি',
  'account.errorDetail': 'সংযোগ দেখে আবার চেষ্টা করুন।',
  'account.retry': 'আবার চেষ্টা করুন',
  'account.cancel': 'বাতিল',
  'account.close': 'বন্ধ করুন',
  'account.continue': 'এগিয়ে যান',
  'account.done': 'হয়ে গেছে',
  'account.saving': 'সংরক্ষণ হচ্ছে…',

  'account.profile.title': 'প্রোফাইল',
  'account.profile.description': 'ইআরপিতে সহকর্মীরা আপনাকে যেভাবে দেখেন।',
  'account.profile.name': 'নাম',
  'account.profile.email': 'ইমেইল',
  'account.profile.emailHint':
    'এই ঠিকানা দিয়েই আপনি সাইন ইন করেন। কোনটি ব্যবহার করবেন, অ্যাডমিন বলে দিতে পারবেন।',
  'account.profile.roles': 'এখানে আপনার ভূমিকা',
  'account.profile.noRoles': 'এই ব্র্যান্ডে কোনো ভূমিকা নেই',
  'account.profile.superAdmin': 'সুপার অ্যাডমিন',
  'account.profile.owner': 'মালিক',
  'account.profile.lastSignIn': 'শেষ সাইন ইন',
  'account.profile.never': 'রেকর্ড নেই',
  'account.profile.save': 'নাম সংরক্ষণ করুন',
  'account.profile.saved': 'আপনার নাম সংরক্ষিত হয়েছে।',
  'account.profile.nameRequired': 'আপনার নাম লিখুন।',

  'account.password.title': 'পাসওয়ার্ড',
  'account.password.description':
    'অন্তত ১২টি অক্ষর ব্যবহার করুন। পরপর কয়েকটি শব্দ মনে রাখা সহজ, আন্দাজ করা কঠিন।',
  'account.password.current': 'বর্তমান পাসওয়ার্ড',
  'account.password.new': 'নতুন পাসওয়ার্ড',
  'account.password.confirm': 'নতুন পাসওয়ার্ড আবার',
  'account.password.signOutOthers': 'আমার অন্য ডিভাইসগুলো থেকে সাইন আউট করুন',
  'account.password.signOutOthersHint':
    'আপনার নামে সাইন ইন করা অন্য প্রতিটি ফোন বা কম্পিউটারে নতুন পাসওয়ার্ড দিয়ে আবার সাইন ইন করতে হবে।',
  'account.password.submit': 'পাসওয়ার্ড বদলান',
  'account.password.changed': 'আপনার পাসওয়ার্ড বদলানো হয়েছে।',
  'account.password.changedSignedOut':
    'আপনার পাসওয়ার্ড বদলানো হয়েছে, আর অন্য ডিভাইসগুলো সাইন আউট হয়েছে।',
  'account.password.tooShort': 'অন্তত ১২টি অক্ষর ব্যবহার করুন।',
  'account.password.mismatch': 'দুটি নতুন পাসওয়ার্ড মেলেনি।',
  'account.password.same': 'নতুন পাসওয়ার্ড বর্তমানটির মতোই।',
  'account.password.required': 'বর্তমান পাসওয়ার্ড লিখুন।',
  'account.password.wrongCurrent': 'বর্তমান পাসওয়ার্ড সঠিক নয়।',
  'account.password.none':
    'আপনি মালিকের সাইন-ইন লিংক দিয়ে আসেন, তাই এখানে বদলানোর মতো কোনো পাসওয়ার্ড নেই।',

  'account.twoFactor.title': 'টু-স্টেপ সাইন-ইন',
  'account.twoFactor.description':
    'পাসওয়ার্ডের পরে আপনার ফোনের অথেনটিকেটর অ্যাপের ছয় সংখ্যার কোড। কেউ আপনার পাসওয়ার্ড জেনে গেলেও আপনার হয়ে সাইন ইন করতে পারবে না।',
  'account.twoFactor.status': 'অবস্থা',
  'account.twoFactor.on': 'চালু',
  'account.twoFactor.off': 'বন্ধ',
  'account.twoFactor.requirement': 'বাধ্যতামূলক',
  'account.twoFactor.requiredRole': 'হ্যাঁ, আপনার ভূমিকার জন্য: {roles}',
  'account.twoFactor.requiredSuperAdmin': 'হ্যাঁ: সুপার অ্যাডমিনদের সবসময় লাগে',
  'account.twoFactor.requiredOwner': 'আপনার মালিকের সাইন-ইন লিংক এটি যাচাই করে',
  'account.twoFactor.requiredElsewhere': 'হ্যাঁ, আপনার অন্য একটি ভূমিকার জন্য',
  'account.twoFactor.notRequired': 'না: আপনার ইচ্ছা',
  'account.twoFactor.since': 'চালু হয়েছে',
  'account.twoFactor.sinceUnknown': 'রেকর্ড নেই',
  'account.twoFactor.codesLeft': 'বাকি রিকভারি কোড',
  'account.twoFactor.codesLow': 'অল্প কয়েকটি রিকভারি কোড বাকি। নতুন কোড বানিয়ে নিন।',
  'account.twoFactor.locked':
    'অনেকবার ভুল কোড দেওয়ায় লক হয়েছে। পনেরো মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
  'account.twoFactor.offRequired':
    'আপনার ভূমিকার জন্য টু-স্টেপ সাইন-ইন বাধ্যতামূলক। এখনই চালু করুন: পরের সাইন-ইনে এমনিতেও চাওয়া হবে।',
  'account.twoFactor.setUp': 'টু-স্টেপ সাইন-ইন চালু করুন',
  'account.twoFactor.newPhone': 'নতুন ফোনে চালু করুন',
  'account.twoFactor.newCodes': 'নতুন রিকভারি কোড',
  'account.twoFactor.turnOff': 'বন্ধ করুন',
  'account.twoFactor.blockedRole': 'আপনার ভূমিকার জন্য এটি বাধ্যতামূলক, তাই চালু থাকবে।',
  'account.twoFactor.blockedSuperAdmin': 'সুপার অ্যাডমিনদের সবসময় লাগে, তাই চালু থাকবে।',
  'account.twoFactor.blockedOwner': 'আপনার মালিকের সাইন-ইন লিংকের জন্য এটি লাগে।',
  'account.twoFactor.password': 'আপনার পাসওয়ার্ড',
  'account.twoFactor.passwordHint': 'আবার চাওয়া হচ্ছে, কারণ এতে আপনার সাইন-ইনের ধরন বদলায়।',
  'account.twoFactor.currentCode': 'অথেনটিকেটর অ্যাপের কোড, অথবা একটি রিকভারি কোড',
  'account.twoFactor.codeFormat': 'অ্যাপে দেখানো ছয়টি সংখ্যা লিখুন।',

  'account.setup.title': 'টু-স্টেপ সাইন-ইন চালু করুন',
  'account.setup.detail':
    'শুরু করতে পাসওয়ার্ড দিন। তারপর Google Authenticator বা Microsoft Authenticator-এর মতো একটি অথেনটিকেটর অ্যাপে আপনার অ্যাকাউন্ট যোগ করুন।',
  'account.setup.scan': 'অথেনটিকেটর অ্যাপ দিয়ে এটি স্ক্যান করুন',
  'account.setup.qr': 'আপনার অথেনটিকেটর অ্যাপের কিউআর কোড',
  'account.setup.manual': 'অথবা এই কী অ্যাপে টাইপ করুন',
  'account.setup.copyKey': 'কী কপি করুন',
  'account.setup.copied': 'কপি হয়েছে',
  'account.setup.codesTitle': 'রিকভারি কোড',
  'account.setup.codesDetail':
    'ফোন হারালে প্রতিটি কোড দিয়ে একবার সাইন ইন করা যায়। এগুলো শুধু এখনই দেখানো হচ্ছে: ফোন থেকে দূরে কোনো নিরাপদ জায়গায় রাখুন।',
  'account.setup.acknowledge': 'আমি রিকভারি কোড সংরক্ষণ করেছি',
  'account.setup.enterCode': 'অ্যাপে এখন যে কোড দেখাচ্ছে তা লিখুন',
  'account.setup.done': 'টু-স্টেপ সাইন-ইন চালু হয়েছে।',

  'account.codes.copy': 'কোড কপি করুন',
  'account.codes.copied': 'কোড কপি হয়েছে',
  'account.codes.download': 'ডাউনলোড',
  'account.codes.print': 'প্রিন্ট',
  'account.codes.printTitle': 'রিকভারি কোড',

  'account.newPhone.title': 'নতুন ফোনে চালু করুন',
  'account.newPhone.detail':
    'নতুন ফোন চালু না হওয়া পর্যন্ত পুরোনো ফোন কাজ করবে। পাসওয়ার্ড আর পুরোনো ফোনের একটি কোড, অথবা একটি রিকভারি কোড দিন।',
  'account.newPhone.step2':
    'নতুন ফোনের অথেনটিকেটর অ্যাপ দিয়ে এটি স্ক্যান করে সেখানে দেখানো কোড লিখুন। আপনার হাতে দশ মিনিট আছে।',
  'account.newPhone.done':
    'নতুন ফোন চালু হয়েছে, পুরোনোটি আর কাজ করবে না। আপনার রিকভারি কোড আগের মতোই আছে।',

  'account.newCodes.title': 'নতুন রিকভারি কোড',
  'account.newCodes.detail':
    'পুরোনো রিকভারি কোডগুলো সঙ্গে সঙ্গে অকেজো হয়ে যাবে। দশটি নতুন কোড বানাতে পাসওয়ার্ড দিন।',
  'account.newCodes.done': 'নতুন রিকভারি কোড তৈরি হয়েছে। পুরোনোগুলো আর কাজ করবে না।',

  'account.turnOff.title': 'টু-স্টেপ সাইন-ইন বন্ধ করবেন?',
  'account.turnOff.detail':
    'শুধু পাসওয়ার্ড দিয়েই সাইন ইন করবেন। নিশ্চিত করতে পাসওয়ার্ড আর একটি বর্তমান কোড দিন।',
  'account.turnOff.done': 'টু-স্টেপ সাইন-ইন বন্ধ হয়েছে।',

  'account.error.password': 'পাসওয়ার্ডটি ভুল।',
  'account.error.code': 'কোডটি গ্রহণ করা হয়নি। অ্যাপে এখন যে কোড দেখাচ্ছে তা লিখুন।',
  'account.error.locked': 'অনেকবার ভুল কোড। পনেরো মিনিট অপেক্ষা করে আবার চেষ্টা করুন।',
  'account.error.expired': 'দশ মিনিটের বেশি সময় লেগেছে। আবার শুরু করুন।',
  'account.error.required': 'আপনার ভূমিকার জন্য টু-স্টেপ সাইন-ইন বাধ্যতামূলক, তাই চালু থাকবে।',
  'account.error.generic': 'কাজটি হয়নি। সংযোগ দেখে আবার চেষ্টা করুন।',

  'account.devices.title': 'ডিভাইস',
  'account.devices.description':
    'এখন যেখানে যেখানে আপনি সাইন ইন করে আছেন। অচেনা কোনোটি থাকলে সাইন আউট করে পাসওয়ার্ড বদলান।',
  'account.devices.caption': 'আপনার সাইন-ইন করা ডিভাইস',
  'account.devices.colDevice': 'ডিভাইস',
  'account.devices.colAddress': 'ঠিকানা',
  'account.devices.colSignedIn': 'সাইন ইন',
  'account.devices.colLastActive': 'শেষ সক্রিয়',
  'account.devices.thisDevice': 'এই ডিভাইস',
  'account.devices.ownerLink': 'মালিকের লিংক',
  'account.devices.browserOn': '{system}-এ {browser}',
  'account.devices.kind.desktop': 'কম্পিউটার',
  'account.devices.kind.phone': 'ফোন',
  'account.devices.kind.tablet': 'ট্যাবলেট',
  'account.devices.kind.unknown': 'ডিভাইস',
  'account.devices.signOut': 'সাইন আউট',
  'account.devices.signOutLabel': '{device} থেকে সাইন আউট',
  'account.devices.signOutOthers': 'অন্য সব ডিভাইস থেকে সাইন আউট',
  'account.devices.signOutOthersTitle': 'অন্য সব ডিভাইস থেকে সাইন আউট করবেন?',
  'account.devices.signOutOthersDetail':
    'আপনার নামে সাইন ইন করা অন্য প্রতিটি ফোন বা কম্পিউটারে আবার সাইন ইন করতে হবে। এই ডিভাইসে সাইন ইন থাকবে।',
  'account.devices.signedOutOthers': 'অন্য ডিভাইসগুলো সাইন আউট হয়েছে।',
  'account.devices.signedOutOne': 'ওই ডিভাইসটি সাইন আউট হয়েছে।',
  'account.devices.onlyThis': 'শুধু এই ডিভাইসেই সাইন ইন করা আছে।',

  'settings.security.caption':
    'এই ব্র্যান্ডে কাদের টু-স্টেপ সাইন-ইন ব্যবহার করতে হবে। কোনো ভূমিকার জন্য চালু করলে যারা এখনো চালু করেননি, তাদের পরের ক্লিকেই চালু করতে বলা হবে; বন্ধ করলে কারও চালু থাকা টু-স্টেপ বন্ধ হয় না।',
  'settings.security.colRole': 'ভূমিকা',
  'settings.security.colRequired': 'টু-স্টেপ সাইন-ইন বাধ্যতামূলক',
  'settings.security.colPeople': 'লোক',
  'settings.security.colWithout': 'চালু করেননি',
  'settings.security.superAdmins': 'সুপার অ্যাডমিন',
  'settings.security.always': 'সবসময় বাধ্যতামূলক',
  'settings.security.byDefault': 'ডিফল্ট',
  'settings.security.save': 'সংরক্ষণ করুন',
  'settings.security.reset': 'পরিবর্তন বাতিল',
  'settings.security.saved': 'সংরক্ষিত হয়েছে।',
  'settings.security.savedWalled':
    'সংরক্ষিত হয়েছে। {n} জনকে পরের ক্লিকেই টু-স্টেপ সাইন-ইন চালু করতে বলা হবে।',
  'settings.security.confirmTitle': 'আরও ভূমিকার জন্য টু-স্টেপ সাইন-ইন বাধ্যতামূলক করবেন?',
  'settings.security.confirmDetail':
    'এই ভূমিকাগুলোর {n} জন এখনো চালু করেননি। পরের ক্লিকেই তারা চালু করার পাতা দেখবেন, আর শেষ না করা পর্যন্ত কাজ করতে পারবেন না।',
  'settings.security.confirm': 'বাধ্যতামূলক করুন',

  'users.twoFactorRequiredNote': 'বাধ্যতামূলক',
  'users.twoFactorOptionalNote': 'ঐচ্ছিক',
  'users.signOutEverywhere': 'সব জায়গা থেকে সাইন আউট',
  'users.signOutEverywhereTitle': '{name}-কে সব জায়গা থেকে সাইন আউট করবেন?',
  'users.signOutEverywhereDetail':
    'তিনি যত ডিভাইসে সাইন ইন করে আছেন, সব থেকে সাইন আউট হবেন। পাসওয়ার্ড আর টু-স্টেপ সাইন-ইন আগের মতোই থাকবে; তিনি আবার সাইন ইন করবেন।',
  'users.signedOutEverywhere': '{name} সাইন আউট হয়েছেন।',
  'users.turnOffTwoFactor': 'টু-স্টেপ বন্ধ করুন',
  'users.turnOffTitle': 'টু-স্টেপ সাইন-ইন বন্ধ করবেন?',
  'users.turnOffDetail':
    'তার কোনো ভূমিকার জন্য এটি বাধ্যতামূলক নয়। আবার চালু না করা পর্যন্ত তিনি শুধু পাসওয়ার্ড দিয়ে সাইন ইন করবেন।',
  'users.turnedOff': 'তার টু-স্টেপ সাইন-ইন বন্ধ হয়েছে।',
  'users.twoFactorRequiredReset':
    'তার ভূমিকার জন্য টু-স্টেপ সাইন-ইন বাধ্যতামূলক। ফোন হারালে রিসেট করুন: পরের সাইন-ইনে তিনি আবার চালু করবেন।',
};

export { bn };
