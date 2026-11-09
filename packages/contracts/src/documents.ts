/**
 * The developer's credit (D-956): one small line at the foot of every document the system
 * prints. That covers the invoice, the packing slip, the parcel and courier labels, the order
 * label sheet, the payslip, every barcode sticker and the till's receipt.
 *
 * One string, shared by the server's templates, the console's sticker preview and the till, so
 * the paper says the same thing everywhere. It names the developer, not a brand, so the
 * white-label check (D-472) has nothing to object to.
 */
export const DOCUMENT_CREDIT = 'Developed by tech.enfinito.com';
