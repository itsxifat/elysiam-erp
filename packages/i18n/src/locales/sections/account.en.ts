/**
 * My account, Settings → Security and the Staff screen's sign-out and turn-off (M40, D-691 to
 * D-697; D-607's pattern): the English section, shipped with those screens rather than in the
 * first download. No string names a brand (M31).
 */
const en = {
  'account.title': 'My account',
  'account.subtitle':
    'Your name, password and two-step sign-in, and the devices you are signed in on.',
  'account.loading': 'Loading your account',
  'account.errorTitle': 'Your account could not be loaded',
  'account.errorDetail': 'Check the connection and try again.',
  'account.retry': 'Try again',
  'account.cancel': 'Cancel',
  'account.close': 'Close',
  'account.continue': 'Continue',
  'account.done': 'Done',
  'account.saving': 'Saving…',

  'account.profile.title': 'Profile',
  'account.profile.description': 'How you appear to your colleagues in the ERP.',
  'account.profile.name': 'Name',
  'account.profile.email': 'Email',
  'account.profile.emailHint':
    'You sign in with this address. An admin can tell you which one to use.',
  'account.profile.roles': 'Your roles here',
  'account.profile.noRoles': 'No role in this brand',
  'account.profile.superAdmin': 'Super admin',
  'account.profile.owner': 'Owner',
  'account.profile.lastSignIn': 'Last signed in',
  'account.profile.never': 'Not recorded',
  'account.profile.save': 'Save name',
  'account.profile.saved': 'Your name is saved.',
  'account.profile.nameRequired': 'Enter your name.',

  'account.password.title': 'Password',
  'account.password.description':
    'Use at least 12 characters. A few words in a row are easy to remember and hard to guess.',
  'account.password.current': 'Current password',
  'account.password.new': 'New password',
  'account.password.confirm': 'New password again',
  'account.password.signOutOthers': 'Sign out my other devices',
  'account.password.signOutOthersHint':
    'Every other phone or computer signed in as you must sign in again with the new password.',
  'account.password.submit': 'Change password',
  'account.password.changed': 'Your password is changed.',
  'account.password.changedSignedOut':
    'Your password is changed, and your other devices are signed out.',
  'account.password.tooShort': 'Use at least 12 characters.',
  'account.password.mismatch': 'The two new passwords differ.',
  'account.password.same': 'The new password is the same as the current one.',
  'account.password.required': 'Enter your current password.',
  'account.password.wrongCurrent': 'Your current password is not right.',
  'account.password.none':
    'You arrive with an owner sign-in link, so there is no password to change here.',

  'account.twoFactor.title': 'Two-step sign-in',
  'account.twoFactor.description':
    'After your password, a six-digit code from an authenticator app on your phone. Someone who learns your password still cannot sign in as you.',
  'account.twoFactor.status': 'Status',
  'account.twoFactor.on': 'On',
  'account.twoFactor.off': 'Off',
  'account.twoFactor.requirement': 'Required',
  'account.twoFactor.requiredRole': 'Yes, for your role: {roles}',
  'account.twoFactor.requiredSuperAdmin': 'Yes: super admins always use it',
  'account.twoFactor.requiredOwner': 'Your owner sign-in link checks it',
  'account.twoFactor.requiredElsewhere': 'Yes, for another of your roles',
  'account.twoFactor.notRequired': 'No: your choice',
  'account.twoFactor.since': 'Set up on',
  'account.twoFactor.sinceUnknown': 'Not recorded',
  'account.twoFactor.codesLeft': 'Recovery codes left',
  'account.twoFactor.codesLow': 'Only a few recovery codes are left. Make new ones.',
  'account.twoFactor.locked':
    'Locked after too many wrong codes. Wait a quarter of an hour, then try again.',
  'account.twoFactor.offRequired':
    'Your role requires two-step sign-in. Set it up now: you will be asked to at your next sign-in anyway.',
  'account.twoFactor.setUp': 'Set up two-step sign-in',
  'account.twoFactor.newPhone': 'Set up on a new phone',
  'account.twoFactor.newCodes': 'New recovery codes',
  'account.twoFactor.turnOff': 'Turn off',
  'account.twoFactor.blockedRole': 'Your role requires it, so it stays on.',
  'account.twoFactor.blockedSuperAdmin': 'Super admins always use it, so it stays on.',
  'account.twoFactor.blockedOwner': 'Your owner sign-in link needs it.',
  'account.twoFactor.password': 'Your password',
  'account.twoFactor.passwordHint': 'Asked again because this changes how you sign in.',
  'account.twoFactor.currentCode': 'Code your authenticator app shows now',
  'account.twoFactor.codeFormat': 'Enter the six digits the app shows.',

  'account.setup.title': 'Set up two-step sign-in',
  'account.setup.detail':
    'Enter your password to begin. Then add your account to an authenticator app, such as Google Authenticator or Microsoft Authenticator.',
  'account.setup.scan': 'Scan this with the authenticator app',
  'account.setup.qr': 'QR code for your authenticator app',
  'account.setup.manual': 'Or type this key into the app',
  'account.setup.copyKey': 'Copy key',
  'account.setup.copied': 'Copied',
  'account.setup.codesTitle': 'Recovery codes',
  'account.setup.codesDetail':
    'Each code signs you in once if your phone is lost. They are shown only now: keep them somewhere safe, away from your phone.',
  'account.setup.acknowledge': 'I have saved my recovery codes',
  'account.setup.enterCode': 'Enter the code the app shows now',
  'account.setup.done': 'Two-step sign-in is on.',

  'account.codes.copy': 'Copy codes',
  'account.codes.copied': 'Codes copied',
  'account.codes.download': 'Download',
  'account.codes.print': 'Print',
  'account.codes.printTitle': 'Recovery codes',

  'account.newPhone.title': 'Set up on a new phone',
  'account.newPhone.detail':
    'Your old phone keeps working until the new one is set up. Enter your password and the code the old phone shows now. If the old phone is lost, ask an admin to reset two-step sign-in.',
  'account.newPhone.step2':
    'Scan this with the authenticator app on the new phone, then enter the code it shows. You have ten minutes.',
  'account.newPhone.done':
    'Your new phone is set up and the old one no longer works. Your recovery codes are unchanged.',

  'account.newCodes.title': 'New recovery codes',
  'account.newCodes.detail':
    'Your old recovery codes stop working at once. Enter your password and the code your authenticator app shows now to make ten new ones.',
  'account.newCodes.done': 'New recovery codes are made. The old ones no longer work.',

  'account.turnOff.title': 'Turn off two-step sign-in?',
  'account.turnOff.detail':
    'You will sign in with your password alone. Enter your password and a current code to confirm.',
  'account.turnOff.done': 'Two-step sign-in is off.',

  'account.error.password': 'That password is wrong.',
  'account.error.code': 'That code was not accepted. Enter the code the app shows now.',
  'account.error.locked': 'Too many wrong codes. Wait a quarter of an hour, then try again.',
  'account.error.expired': 'That took longer than ten minutes. Start again.',
  'account.error.required': 'Your role requires two-step sign-in, so it stays on.',
  'account.error.generic': 'That did not work. Check the connection and try again.',

  'account.devices.title': 'Devices',
  'account.devices.description':
    'Where you are signed in now. Sign out any you do not recognise, then change your password.',
  'account.devices.caption': 'Your signed-in devices',
  'account.devices.colDevice': 'Device',
  'account.devices.colAddress': 'Address',
  'account.devices.colSignedIn': 'Signed in',
  'account.devices.colLastActive': 'Last active',
  'account.devices.thisDevice': 'This device',
  'account.devices.ownerLink': 'Owner link',
  'account.devices.browserOn': '{browser} on {system}',
  'account.devices.kind.desktop': 'Computer',
  'account.devices.kind.phone': 'Phone',
  'account.devices.kind.tablet': 'Tablet',
  'account.devices.kind.unknown': 'Device',
  'account.devices.signOut': 'Sign out',
  'account.devices.signOutLabel': 'Sign out {device}',
  'account.devices.signOutOthers': 'Sign out all other devices',
  'account.devices.signOutOthersTitle': 'Sign out all other devices?',
  'account.devices.signOutOthersDetail':
    'Every other phone or computer signed in as you must sign in again. This device stays signed in.',
  'account.devices.signedOutOthers': 'Your other devices are signed out.',
  'account.devices.signedOutOne': 'That device is signed out.',
  'account.devices.onlyThis': 'Only this device is signed in.',

  'settings.security.caption':
    'Who must use two-step sign-in in this brand. Switching a role on asks its people who have not set it up to do so at their next click; switching it off never turns anyone’s off.',
  'settings.security.colRole': 'Role',
  'settings.security.colRequired': 'Two-step sign-in required',
  'settings.security.colPeople': 'People',
  'settings.security.colWithout': 'Not set up',
  'settings.security.superAdmins': 'Super admins',
  'settings.security.always': 'Always required',
  'settings.security.byDefault': 'Default',
  'settings.security.save': 'Save',
  'settings.security.reset': 'Undo changes',
  'settings.security.saved': 'Saved.',
  'settings.security.savedWalled':
    'Saved. {n} people will be asked to set up two-step sign-in at their next click.',
  'settings.security.confirmTitle': 'Require two-step sign-in for more roles?',
  'settings.security.confirmDetail':
    '{n} people in these roles have not set it up. They will see the set-up screen at their next click and cannot work until they finish.',
  'settings.security.confirm': 'Require it',

  'users.twoFactorRequiredNote': 'Required',
  'users.twoFactorOptionalNote': 'Optional',
  'users.signOutEverywhere': 'Sign out everywhere',
  'users.signOutEverywhereTitle': 'Sign {name} out everywhere?',
  'users.signOutEverywhereDetail':
    'Every device they are signed in on is signed out. Their password and two-step sign-in stay; they simply sign in again.',
  'users.signedOutEverywhere': '{name} is signed out.',
  'users.turnOffTwoFactor': 'Turn off two-step',
  'users.turnOffTitle': 'Turn off two-step sign-in?',
  'users.turnOffDetail':
    'Nothing requires it for their roles. They will sign in with their password alone until they set it up again.',
  'users.turnedOff': 'Two-step sign-in is off for them.',
  'users.twoFactorRequiredReset':
    'Their role requires two-step sign-in. If their phone is lost, reset it: they set it up again at their next sign-in.',
} as const;

/** The keys of this section. */
export type AccountKey = keyof typeof en;

export { en };
