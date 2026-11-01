import { z } from 'zod';

/**
 * The return station's request shapes (M51, D-934), a subpath of their own
 * (`@elysium/contracts/packing-returns`) so the console's first download does not carry them.
 */

const uuid = z.string().uuid('No such record.');
const packingCodeSchema = z.string().trim().min(1).max(120);
const cameraChoice = uuid.nullable().optional();

/** Open the return station on a parcel that came back: by its scanned label, or the order's id. */
export const packingReturnOpenSchema = z.union([
  z.object({ code: packingCodeSchema, cameraId: cameraChoice }).strict(),
  z.object({ orderId: uuid, cameraId: cameraChoice }).strict(),
]);
export type PackingReturnOpenInput = z.infer<typeof packingReturnOpenSchema>;

/**
 * Receive the inspected return into stock (D-934): per SKU how many of the pieces scanned back are
 * damaged, why it came back (the fixed list, D-234) and the note, the shelf the damaged go to.
 */
export const packingReturnReceiveSchema = z
  .object({
    damaged: z
      .array(z.object({ skuId: uuid, qty: z.number().int().min(1).max(10_000) }).strict())
      .max(200)
      .default([]),
    returnReason: z.string().trim().min(1).max(64),
    reason: z.string().trim().min(1).max(500),
    // Short of the receipt's 1,000: what did not come back is written in front of it.
    inspectionNote: z.string().trim().max(600).optional(),
    damagedLocationId: uuid.optional(),
    /**
     * The person saw that pieces did not come back or a bag was not opened (D-939). A parcel has
     * one receipt, so what is left out can never be booked in later: it is said, not assumed.
     */
    acknowledgeShort: z.boolean().optional(),
  })
  .strict();
export type PackingReturnReceiveInput = z.infer<typeof packingReturnReceiveSchema>;
