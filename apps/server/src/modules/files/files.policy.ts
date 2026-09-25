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
};
