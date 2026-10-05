import type { Action, Subject } from '@elysium/contracts';
import { z } from 'zod';

/**
 * What a file is for, and which permission that makes it (architecture §22, §6).
 *
 * The file endpoints are one door, and `read FileObject` is the key to the
 * door. This table is what is behind it: the document-level question, answered
 * by mapping the file's purpose onto the subject the document is actually
 * about. A payslip is Payroll, a KYC scan is Employee, an invoice is a ledger
 * report, a product image is the catalogue.
 *
 * Without this, `read FileObject` at org scope is a single grant that hands
 * every staff role every payslip in the brand — and it has to be at org scope,
 * because an order desk agent legitimately downloads a courier's
 * proof-of-delivery for somebody else's order. So the coarse grant opens the
 * endpoint and this decides the row (D-115).
 *
 * Adding a purpose means adding a line here. A purpose with no line is refused
 * rather than allowed, which is the only safe direction: the failure mode of
 * the opposite default is a new document type that silently defaults to
 * readable by everyone, discovered by the person it was about.
 */
export const FILE_PURPOSES = [
  /** Trade licence, NID, bank details: a reseller's or employee's identity. */
  'kyc',
  /** A rendered sales or supplier invoice. */
  'invoice',
  /** A payslip (§12). The most sensitive thing in the store. */
  'payslip',
  /** Catalogue imagery (§6 Catalog). Usually public. */
  'product-image',
  /** A courier's proof of delivery or a return photo (§9). */
  'courier-proof',
  /** A customer's payment screenshot attached to an order (§9). */
  'order-payment-proof',
  /** A supplier's quotation, challan or agreement (§9). */
  'supply-document',
  /** A courier's settlement sheet (§12). */
  'settlement-sheet',
  /** Creative for an ad campaign (§11). */
  'campaign-asset',
  /**
   * The receipt photo behind a petty-cash entry (M08, §7).
   *
   * Private without exception: a till receipt is photographed on a phone in a
   * showroom, and what lands in the frame is not controlled — a customer's
   * delivery slip on the counter, a staff member's face, the shop's own bank
   * paperwork. It is also the evidence for money leaving the company, which is
   * a document a checker and an auditor read and nobody else does.
   */
  'petty-cash-receipt',
  /**
   * An investor's KYC scan, investment agreement or statement (M25, §15, §25).
   *
   * Private without exception, and read through `Investor` rather than through
   * `LedgerReport` or `Employee`: §6 gives investors to accounts and org_admin
   * org-wide and to the investor themselves at `own` scope, and it is the only
   * subject that lets an investor open their own agreement without granting them
   * anything else. `Employee` — the other KYC purpose — would have denied the
   * finance team the very documents they file.
   */
  'investor-document',
  /** A category's picture on the brand's website (M33, D-501). Public. */
  'category-image',
  /**
   * The website's own imagery: hero slides and the site logo (M33, D-504). Public. Read
   * through `Storefront`, the subject of the screens that upload it.
   */
  'storefront-image',
] as const;

export type FilePurpose = (typeof FILE_PURPOSES)[number];

export const filePurposeSchema = z.enum(FILE_PURPOSES);

export interface PurposeRule {
  /** The ability a non-owner needs to read a private file of this purpose. */
  readonly readRequires: { readonly action: Action; readonly subject: Subject };
  /**
   * Whether an object of this purpose may ever be public.
   *
   * A hard `false` for anything personal. `visibility: 'public'` on an upload
   * request is a client-supplied field, and a client-supplied field that can
   * make a payslip world-readable is not a field, it is a bug waiting for a
   * typo. Only imagery and campaign creative can opt in.
   */
  readonly mayBePublic: boolean;
  /**
   * The ability an upload of this purpose needs beyond `create FileObject`, when the
   * purpose belongs to one team's screens (M33's ledger audit, L6). A public website image
   * is served on the brand's own domain the moment it is stored, so only the people who
   * manage the website may put one there.
   */
  readonly createRequires?: { readonly action: Action; readonly subject: Subject };
}

export const PURPOSE_RULES: Readonly<Record<FilePurpose, PurposeRule>> = {
  // §6's employees row. HR and org_admin org-wide; everybody else only their own.
  kyc: { readRequires: { action: 'read', subject: 'Employee' }, mayBePublic: false },
  invoice: { readRequires: { action: 'read', subject: 'LedgerReport' }, mayBePublic: false },
  payslip: { readRequires: { action: 'read', subject: 'Payroll' }, mayBePublic: false },
  'product-image': { readRequires: { action: 'read', subject: 'Catalog' }, mayBePublic: true },
  'courier-proof': { readRequires: { action: 'read', subject: 'Order' }, mayBePublic: false },
  'order-payment-proof': { readRequires: { action: 'read', subject: 'Order' }, mayBePublic: false },
  /*
   * Supply, not Catalog. A supplier's quotation carries purchase prices, and
   * invariant 5 keeps purchase cost inside supply, inventory and ledger — a
   * document is not exempt from that because it is a PDF.
   */
  'supply-document': { readRequires: { action: 'read', subject: 'Supply' }, mayBePublic: false },
  'settlement-sheet': {
    readRequires: { action: 'read', subject: 'CourierSettlement' },
    mayBePublic: false,
  },
  'campaign-asset': { readRequires: { action: 'read', subject: 'Campaign' }, mayBePublic: true },
  /*
   * `read Wallet`, not `read LedgerReport`. §6's "Wallets, cash entries, petty
   * cash" row is the capability this document belongs to: org_admin and accounts
   * org-wide, a branch manager for their own branch's tills. `LedgerReport` would
   * have been close enough to look right and wrong in one direction that matters
   * — it is the reports grant, so it would have opened receipts to a role whose
   * business is reading totals rather than approving spending.
   */
  'petty-cash-receipt': { readRequires: { action: 'read', subject: 'Wallet' }, mayBePublic: false },
  /*
   * Never public. An investor agreement carries capital amounts and an NID; a
   * public object is served by the CDN with no authorization at all, so one
   * mis-set `visibility` would put a brand's funding terms on a guessable URL.
   */
  'investor-document': {
    readRequires: { action: 'read', subject: 'Investor' },
    mayBePublic: false,
  },
  'category-image': {
    readRequires: { action: 'read', subject: 'Catalog' },
    mayBePublic: true,
    createRequires: { action: 'update', subject: 'Storefront' },
  },
  'storefront-image': {
    readRequires: { action: 'read', subject: 'Storefront' },
    mayBePublic: true,
    createRequires: { action: 'update', subject: 'Storefront' },
  },
};

/**
 * The purposes the public media path serves (M33, D-507): what the brand's website shows.
 *
 * An allow-list, and narrower than "may be public". Since M34 a public `campaign-asset` is
 * served too (a flash sale's banner, D-538); every private purpose is refused by
 * construction, and so is a public file of any purpose added later until somebody decides
 * the website needs it. The row must also be `public` and `stored`: a purpose alone never
 * makes a file servable.
 */
export const PUBLIC_MEDIA_PURPOSES: readonly FilePurpose[] = [
  'product-image',
  'category-image',
  'storefront-image',
  /*
   * M34 (D-538): a flash sale's banner is a public `campaign-asset` (M35a, D-547) that the
   * website shows on its sale pages, so public campaign images are the website's too. Still only
   * a `public`, `stored` row, and still only its re-encoded sizes.
   */
  'campaign-asset',
];
