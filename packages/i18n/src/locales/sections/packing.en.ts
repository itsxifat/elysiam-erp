/**
 * Orders → Scan and the label sheet (M35b; D-607's pattern): the English section, shipped with
 * the orders screens. No string names a brand: the console is white-label (M31).
 */
const en = {
  'pk.nav.scan': 'Scan',
  // M38b: the packing station's tab, here so the orders tabs need no other section.
  'pk.nav.pack': 'Pack',
  'pk.actions': 'Actions',
  'pk.cancel': 'Cancel',
  'pk.close': 'Close',
  'pk.done': 'Done',
  'pk.loading': 'Loading…',
  'pk.scan.title': 'Scan a parcel',
  'pk.scan.description':
    'Scan the courier’s parcel code or an order number to see what goes in the parcel.',
  'pk.scan.label': 'Parcel code or order number',
  'pk.scan.hint': 'Scan the label with a scanner or the camera, or type the code and press Enter.',
  'pk.scan.looking': 'Looking it up…',
  'pk.scan.notFound': 'No order you can see has this code:',
  'pk.scan.failed': 'The lookup did not work. Try again.',
  'pk.scan.order': 'Order',
  'pk.scan.paid': 'Paid',
  'pk.scan.collect': 'Collect',
  'pk.scan.recipient': 'Deliver to',
  'pk.scan.contents': 'In the parcel',
  'pk.scan.units': 'pieces',
  'pk.scan.lines': 'items',
  'pk.scan.notes': 'Note',
  'pk.scan.quantity': 'Quantity',
  'pk.devices.title': 'Scanner app',
  'pk.devices.description':
    'Phones signed in to the packing scanner app. A sign-in lasts 30 days; end one here when a phone is lost or changes hands.',
  'pk.devices.pair': 'Pair a phone',
  'pk.devices.none': 'No phone is signed in.',
  'pk.devices.name': 'Phone',
  'pk.devices.namePlaceholder': 'Packing desk phone',
  'pk.devices.person': 'Person',
  'pk.devices.lastUsed': 'Last used',
  'pk.devices.expires': 'Signed in until',
  'pk.devices.state': 'State',
  'pk.devices.never': 'Not yet',
  'pk.devices.active': 'Signed in',
  'pk.devices.expired': 'Expired',
  'pk.devices.revoked': 'Signed out',
  'pk.devices.viaCode': 'paired',
  'pk.devices.viaPassword': 'password',
  'pk.devices.revoke': 'Sign out',
  'pk.devices.revokeTitle': 'Sign this phone out?',
  'pk.devices.revokeDetail':
    'The scanner app on it stops working at once. Its person can sign in again.',
  'pk.devices.pairTitle': 'Pair a phone',
  'pk.devices.pairHelp':
    'Makes a one-time sign-in code for the scanner app, in your name. Name the phone so you can tell it apart later.',
  'pk.devices.makeCode': 'Make the code',
  'pk.devices.codeHelp':
    'Paste this code into the scanner app. It is shown only now; anyone who has it can read your orders until it expires or is signed out.',
  'pk.devices.copyCode': 'Copy the code',
  'pk.devices.validUntil': 'Works until',
  'pk.labels.action': 'Label sheet',
  'pk.labels.title': 'Print order labels',
  'pk.labels.orders': 'orders',
  'pk.labels.size': 'Paper',
  'pk.labels.layout': 'Turned',
  'pk.labels.portrait': 'Upright',
  'pk.labels.landscape': 'Sideways',
  'pk.labels.shopName': 'Shop name',
  'pk.labels.qr': 'QR code',
  'pk.labels.prices': 'Item prices',
  'pk.labels.cod': 'Amount to collect',
  'pk.labels.print': 'Print',
  'pk.labels.open': 'Open the labels',
  'pk.labels.failed': 'The labels could not be made.',
  'pk.labels.size.a4': 'A4',
  'pk.labels.size.a5': 'A5',
  'pk.labels.size.a6': 'A6',
  'pk.labels.size.2x3': '2 × 3 in',
  'pk.labels.size.3x2': '3 × 2 in',
  'pk.labels.size.4x6': '4 × 6 in (thermal)',
  'pk.labels.size.100x150': '100 × 150 mm (thermal)',
  'pk.labels.size.80mm': '80 mm roll',
} as const;

/** The keys of this section. */
export type PackingKey = keyof typeof en;

export { en };
