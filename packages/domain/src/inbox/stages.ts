/**
 * Where a contact stands with the brand (M42, D-738).
 *
 * - `visitor`: wrote to us; nothing more is known.
 * - `lead`: an agent marked them as likely to buy.
 * - `customer`: they have ordered. Never set by hand: it follows from an order.
 * - `not_qualified`: an agent decided they will not buy (wrong area, wholesale ask, spam).
 * - `fraud`: an agent flagged them. Sticky: an order placed afterwards does not clear it, and the
 *   order desk warns on their phone.
 *
 * Independent of `marketing.leads` (M18's segment records): a Lead here is the inbox's own
 * label, and nothing copies it there.
 */

export const CONTACT_STAGES = ['visitor', 'lead', 'customer', 'not_qualified', 'fraud'] as const;
export type ContactStage = (typeof CONTACT_STAGES)[number];

/** What an agent may choose. `auto` hands the stage back to the rules (customer or visitor). */
export const MANUAL_STAGE_CHOICES = ['lead', 'not_qualified', 'fraud', 'auto'] as const;
export type ManualStageChoice = (typeof MANUAL_STAGE_CHOICES)[number];

export interface StageFacts {
  /** The contact's linked customer has at least one order with the brand. */
  readonly hasOrdered: boolean;
}

export type StageChange =
  | { readonly ok: true; readonly stage: ContactStage }
  | {
      readonly ok: false;
      /** `already_customer`: someone who has ordered is a customer, not a lead. */
      readonly reason: 'already_customer';
    };

/** The stage the rules give when nobody has chosen one. */
export function automaticStage(facts: StageFacts): ContactStage {
  return facts.hasOrdered ? 'customer' : 'visitor';
}

/** An agent's choice, applied. */
export function chooseStage(choice: ManualStageChoice, facts: StageFacts): StageChange {
  switch (choice) {
    case 'auto':
      return { ok: true, stage: automaticStage(facts) };
    case 'lead':
      return facts.hasOrdered
        ? { ok: false, reason: 'already_customer' }
        : { ok: true, stage: 'lead' };
    case 'not_qualified':
    case 'fraud':
      return { ok: true, stage: choice };
  }
}

/** The stage after the contact's customer places an order. Fraud stays fraud. */
export function stageAfterOrder(current: ContactStage): ContactStage {
  return current === 'fraud' ? 'fraud' : 'customer';
}

/**
 * The stage to show, reconciling what is stored with what is known now: a stored visitor, lead
 * or not-qualified contact whose customer has ordered (an order taken at the desk without the
 * chat, say) is shown, and saved, as a customer.
 */
export function reconcileStage(stored: ContactStage, facts: StageFacts): ContactStage {
  return facts.hasOrdered ? stageAfterOrder(stored) : stored;
}
