/**
 * The order workflow (M41; D-607's pattern): ownership, presence, auto-assign's offers, the
 * desk's and the hub's queues, the team board and their settings. The English section, shipped
 * with the orders screens and the shell's lazy work dock. No string names a brand: the console
 * is white-label (M31).
 */
const en = {
  'wf.loading': 'Loading…',
  'wf.failed': 'That did not work. Try again.',
  'wf.retry': 'Try again',
  'wf.cancel': 'Cancel',
  'wf.close': 'Close',
  'wf.save': 'Save',
  'wf.saving': 'Saving…',
  'wf.saved': 'Saved.',
  'wf.someone': 'A colleague',
  'wf.order': 'Order',
  'wf.customer': 'Customer',
  'wf.cod': 'Collect',
  'wf.items': 'Pieces',
  'wf.owner': 'Handled by',
  'wf.nobody': 'Nobody',
  'wf.waitingSince': 'Waiting since',
  'wf.stage': 'At the hub',

  // Presence and the work dock.
  'wf.dock.label': 'Your work',
  'wf.status.active': 'Active',
  'wf.status.idle': 'Idle',
  'wf.status.away': 'Away',
  'wf.status.taking': 'Taking orders',
  'wf.status.paused': 'Not taking orders',
  'wf.status.pause': 'Stop taking orders',
  'wf.status.resume': 'Start taking orders',
  'wf.status.yours': 'Your status',

  // An offer.
  'wf.offer.title': 'New order for you',
  'wf.offer.detail': 'Accept it to make it yours. If you do not, it goes to the next person.',
  'wf.offer.left': 'seconds left',
  'wf.offer.pieces': 'pieces',
  'wf.offer.accept': 'Accept',
  'wf.offer.decline': 'Decline',
  'wf.offer.gone': 'This offer has ended.',
  'wf.offer.announce': 'New order offered to you:',

  // Somebody acted on your order.
  'wf.notice.on': 'on your order',
  'wf.notice.dismiss': 'Dismiss',
  'wf.act.edit': 'edited',
  'wf.act.confirm': 'confirmed',
  'wf.act.hold': 'put on hold',
  'wf.act.release_hold': 'released from hold',
  'wf.act.cancel': 'cancelled',
  'wf.act.exchange': 'exchanged',
  'wf.act.advance': 'recorded an advance',
  'wf.act.call': 'logged a call',
  'wf.act.reassign': 'reassigned',
  'wf.act.release': 'released',
  'wf.act.hand_over': 'handed over',
  'wf.act.take': 'took',
  'wf.act.other': 'acted',

  // Ownership on the order page.
  'wf.own.handledBy': 'Handled by',
  'wf.own.since': 'since',
  'wf.own.warn':
    'Anything you do on this order asks you to confirm first, and they are told what you did.',
  'wf.own.yours': 'You are handling this order',
  'wf.own.yoursDetail': 'Nobody else works it while it is yours.',
  'wf.own.nobody': 'Nobody is handling this order yet',
  'wf.own.nobodyDetail': 'Take it before you call the buyer, so nobody else calls them too.',
  'wf.own.take': 'Take this order',
  'wf.own.taking': 'Taking…',
  'wf.own.taken': 'Somebody took it first:',
  'wf.own.release': 'Release',
  'wf.own.releaseDetail': 'Put it back in New for someone else to take.',
  'wf.own.handOver': 'Hand over',
  'wf.own.reassign': 'Reassign',
  'wf.own.handOverTitle': 'Hand this order to a colleague',
  'wf.own.reassignTitle': 'Reassign this order',
  'wf.own.person': 'Person',
  'wf.own.choose': 'Choose a person',
  'wf.own.ackTitle': 'Someone else is handling this order',
  'wf.own.ackDetail':
    'They are working on it now. Go ahead only if you must; they will be told what you did.',
  'wf.own.ackGo': 'Go ahead',
  'wf.own.ackStop': 'Leave it to them',

  // Verification calls.
  'wf.calls.title': 'Verification calls',
  'wf.calls.attempts': 'attempts',
  'wf.calls.none': 'No calls logged yet.',
  'wf.calls.outcome': 'What happened',
  'wf.calls.callBackAt': 'Call back at',
  'wf.calls.note': 'Note',
  'wf.calls.log': 'Log call',
  'wf.calls.logging': 'Logging…',
  'wf.calls.by': 'by',
  'wf.calls.due': 'Call-back due',
  'wf.calls.callBack': 'Call back',
  'wf.calls.needTime': 'Say when to call back.',
  'wf.outcome.reached': 'Reached',
  'wf.outcome.no_answer': 'No answer',
  'wf.outcome.busy': 'Busy',
  'wf.outcome.wrong_number': 'Wrong number',
  'wf.outcome.call_back': 'Call back later',

  // The order's timeline.
  'wf.tl.released': 'Put back in New',
  'wf.tl.actedOver': 'Worked on while someone else had it',
  'wf.tl.call': 'Verification call logged',
  'wf.tl.offered': 'Offered by auto-assign',
  'wf.tl.accepted': 'Offer accepted',
  'wf.tl.declined': 'Offer declined',
  'wf.tl.expired': 'Offer ran out',
  'wf.tl.printed': 'Slip printed at the hub',

  // The hub's stages.
  'wf.hub.to_print': 'To print',
  'wf.hub.packing': 'Packing',
  'wf.hub.packed': 'Packed',
  'wf.hub.handed_over': 'Handed to courier',

  // The sales desk.
  'wf.desk.title': 'Sales desk',
  'wf.desk.subtitle':
    'New orders, the orders you are verifying, and today’s confirmations as the hub works them.',
  'wf.desk.new': 'New',
  'wf.desk.mine': 'Mine',
  'wf.desk.verifying': 'Verifying',
  'wf.desk.callbacks': 'Call-backs due',
  'wf.desk.confirmed': 'Confirmed today',
  'wf.desk.calls': 'Calls',
  'wf.desk.emptyNew': 'No new orders are waiting.',
  'wf.desk.emptyNewDetail': 'New orders from every channel appear here the moment they arrive.',
  'wf.desk.empty': 'Nothing here.',
  'wf.desk.emptyDetail': 'Orders appear here as they reach this step.',
  'wf.desk.take': 'Take',

  // The fulfilment hub.
  'wf.hubPage.title': 'Fulfilment hub',
  'wf.hubPage.subtitle':
    'Confirmed orders at the hub: print the slips, pack each order, then hand the parcels to the courier.',
  'wf.hubPage.location': 'Location',
  'wf.hubPage.allLocations': 'All locations',
  'wf.hubPage.selectAll': 'Select all',
  'wf.hubPage.select': 'Select',
  'wf.hubPage.printSlips': 'Print slips',
  'wf.hubPage.printLabels': 'Print labels',
  'wf.hubPage.selected': 'selected',
  'wf.hubPage.pack': 'Pack',
  'wf.hubPage.handover': 'Hand over to the courier',
  'wf.hubPage.scan': 'Scan or type an order number',
  'wf.hubPage.scanHint': 'Scan each parcel’s slip as it goes to the courier, then hand them over.',
  'wf.hubPage.add': 'Add',
  'wf.hubPage.remove': 'Remove',
  'wf.hubPage.notPacked': 'is not packed and waiting here.',
  'wf.hubPage.already': 'is already in the list.',
  'wf.hubPage.handOverN': 'Hand over',
  'wf.hubPage.parcels': 'parcels',
  'wf.hubPage.handedOver': 'handed over.',
  'wf.hubPage.refused': 'refused:',
  'wf.hubPage.emptyTitle': 'Nothing at this step.',
  'wf.hubPage.emptyDetail': 'Orders move here as the hub works them.',
  'wf.hubPage.denied': 'Your role does not work the hub.',

  // The team board.
  'wf.team.title': 'Team board',
  'wf.team.subtitle':
    'Who is active in the ERP, what they hold, what they confirmed today and the orders on offer.',
  'wf.team.waiting': 'Waiting in New',
  'wf.team.autoOn': 'Auto-assign is on',
  'wf.team.autoOff': 'Auto-assign is off',
  'wf.team.person': 'Person',
  'wf.team.status': 'Status',
  'wf.team.open': 'Open orders',
  'wf.team.confirmed': 'Confirmed today',
  'wf.team.offer': 'Offer',
  'wf.team.offerOpen': 'Offer open',
  'wf.team.noOffer': 'None',
  'wf.team.lastSeen': 'Last seen',
  'wf.team.showOrders': 'Show orders',
  'wf.team.hideOrders': 'Hide orders',
  'wf.team.noOrders': 'No open orders.',
  'wf.team.reassignTo': 'Reassign to',
  'wf.team.empty': 'Nobody works orders here yet.',
  'wf.team.denied': 'The team board is for supervisors.',

  // Settings → Order workflow.
  'wf.settings.tab': 'Order workflow',
  'wf.settings.title': 'Order workflow',
  'wf.settings.subtitle':
    'One person handles each order. Auto-assign offers each new order to the active person with the fewest open orders.',
  'wf.settings.autoAssign': 'Offer new orders automatically',
  'wf.settings.autoAssignHint':
    'Each new order is offered to one active person at a time. They accept or decline before the countdown ends; otherwise it goes to the next person.',
  'wf.settings.offerSeconds': 'Seconds to accept an offer',
  'wf.settings.offerSecondsHint': 'Between 15 and 300.',
  'wf.settings.maxOpen': 'Most open orders per person',
  'wf.settings.maxOpenHint': 'Pending and on-hold orders count. Between 1 and 200.',
  'wf.settings.denied': 'Only an org admin changes the order workflow.',

  // Staff → desk profile.
  'wf.profile.title': 'Desk profile',
  'wf.profile.detail':
    'What this person may be offered, and the hub they pack at. Sales staff take orders and messages unless this says otherwise.',
  'wf.profile.workTypes': 'Work types',
  'wf.profile.orders': 'Orders',
  'wf.profile.messages': 'Messages',
  'wf.profile.hub': 'Hub location',
  'wf.profile.noHub': 'No hub (every location)',
  'wf.profile.default': 'Role default',
} as const;

/** The keys of this section. */
export type WorkflowKey = keyof typeof en;

export { en };
