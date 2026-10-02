/**
 * Stable error codes (architecture §23 "Errors").
 *
 * A response that fails carries one of these as `code`, so a client branches
 * on a code rather than on the wording of a message. M03 seeds the ledger's;
 * M04 turns every error into RFC 9457 problem+json around the same codes
 * (D-087). Codes are append-only: renaming one breaks every client that
 * branches on it.
 */
export const ERROR_CODES = [
  // Ledger (M03)
  'PERIOD_CLOSED',
  'PERIOD_NOT_ENDED',
  'PERIOD_ALREADY_CLOSED',
  'PERIOD_NOT_CLOSED',
  'PERIOD_REOPEN_UNAUTHORISED',
  'PERIOD_REOPEN_PENDING',
  'PERIOD_LATER_CLOSED',
  'JOURNAL_UNBALANCED',
  'JOURNAL_TOO_FEW_LINES',
  'JOURNAL_LINE_INVALID',
  'JOURNAL_KEY_INVALID',
  'JOURNAL_DATE_INVALID',
  'JOURNAL_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'LEDGER_ACCOUNT_INVALID',
  'LEDGER_ACCOUNT_NOT_FOUND',
  'LEDGER_IMMUTABLE',
  'POSTING_INPUT_INVALID',
  'MONEY_INVALID',
  'MONEY_OVERFLOW',

  // Wallets and the cash picture (M08, §7)
  /** Petty cash was submitted with no receipt photo, or with one nobody may read. */
  'RECEIPT_REQUIRED',
  /** That wallet has already been counted for that business date. */
  'CLOSING_ALREADY_RECORDED',
  /** The wallet exists but is deactivated, so nothing may be posted to it. */
  'WALLET_INACTIVE',
  /** That receipt is already the evidence for another cash entry. */
  'RECEIPT_ALREADY_USED',
  /** A wallet still holding money cannot be closed; move the money out first. */
  'WALLET_NOT_EMPTY',
  /*
   * Catalog (M06).
   *
   * `CATALOG_SKU_IMMUTABLE` and `CATALOG_CATEGORY_CYCLE` are raised by the
   * database as well as by the service (migration 0026), so they are here rather
   * than being invented at the HTTP edge — a client branching on the code gets
   * the same answer whichever layer refused.
   */
  'CATALOG_NOT_FOUND',
  'CATALOG_DUPLICATE',
  'CATALOG_SKU_IMMUTABLE',
  'CATALOG_PRODUCT_IMMUTABLE',
  'CATALOG_CATEGORY_CYCLE',
  'CATALOG_CATEGORY_INVALID',
  'CATALOG_VARIANT_INVALID',
  'CATALOG_PRICE_INVALID',
  'CATALOG_IMPORT_REJECTED',
  /*
   * Stock, locations and costing (M07, §8).
   *
   * `STOCK_INSUFFICIENT` was named by §23 and is the one a caller will see most:
   * it is the answer when the reservation's conditional UPDATE matched no row.
   * The rest are raised by both the service and migrations 0033 and 0034, so a
   * client branching on the code gets the same answer whichever layer refused —
   * and which layer refuses depends on concurrency, so a client that branched on
   * the status alone would behave differently under load than in testing.
   */
  'STOCK_INSUFFICIENT',
  'STOCK_NOT_FOUND',
  'STOCK_LOCATION_INVALID',
  'STOCK_MOVEMENT_INVALID',
  /** A movement was updated or deleted. They are append-only (invariant 3). */
  'STOCK_MOVEMENT_IMMUTABLE',
  /** On-hand changed with no movement behind it in the same transaction. */
  'STOCK_MOVEMENT_REQUIRED',
  'STOCK_COUNT_INVALID',
  'STOCK_TRANSFER_INVALID',
  /** An adjustment's terms are fixed once its approval is raised. */
  'STOCK_ADJUSTMENT_FROZEN',
  /** The approval named does not match the adjustment's branch, type or amount. */
  'STOCK_ADJUSTMENT_APPROVAL_INVALID',
  /*
   * Suppliers and purchasing (M09, §7, §8).
   *
   * Raised by the services and again by migration 0037's triggers, so a client
   * branching on the code gets the same answer whichever layer refused — and which
   * layer refuses depends on concurrency, which is the whole point of
   * `SUPPLY_ADVANCE_INVALID`: two clerks applying one advance to two deliveries at
   * once are stopped by the trigger's row lock, not by the service.
   */
  'SUPPLY_NOT_FOUND',
  /** A received supply, a return or an advance application cannot be changed. */
  'SUPPLY_IMMUTABLE',
  /** A supply was received with a line carrying no unit cost (D-005). */
  'SUPPLY_COST_REQUIRED',
  /** The supplier exists but is deactivated, so nothing new may be bought. */
  'SUPPLIER_INACTIVE',
  /** The advance is not posted, is another supplier's, or holds less than this. */
  'SUPPLY_ADVANCE_INVALID',
  /** A supplier payment's terms are fixed once its approval is raised. */
  'SUPPLY_PAYMENT_FROZEN',

  /*
   * Orders (M10, §9, §23).
   *
   * `ORDER_TRANSITION_INVALID` was named by §23 from the start and is the one a client
   * meets most: it means the order moved while the screen was open, so the right
   * response is to reload rather than to change the body. It is raised by the domain
   * state machine, by the service, and again by migration 0041's trigger — three layers
   * stating the same table, because which one refuses depends on the path, and a client
   * that saw one code in testing and a 500 in production would be debugging the wrong
   * thing.
   */
  'ORDER_TRANSITION_INVALID',
  'ORDER_NOT_FOUND',
  /** A transition §9 marks as needing a reason was given none. */
  'ORDER_REASON_REQUIRED',
  /** §10's fraud rules block this buyer; confirming needs an org_admin override. */
  'ORDER_FRAUD_BLOCKED',
  /** §9's COD formula refused: a negative result, or a discount beyond the items. */
  'ORDER_TOTAL_INVALID',
  'ORDER_LINES_INVALID',
  'ORDER_PHONE_INVALID',
  /** An order number, or an order's org, cannot change once written (0041). */
  'ORDER_IMMUTABLE',
  /** A shipped order's quantities, prices and discounts are fixed (0041). */
  'ORDER_LINES_FROZEN',
  /** An order's status history is append-only (0041). */
  'ORDER_EVENT_IMMUTABLE',
  /** Somebody else took this order out of the unassigned queue first (§6). */
  'ORDER_ALREADY_CLAIMED',
  /**
   * A receipt changed the weighted average between pricing the dispatch and recording
   * it, so the cost written on the lines would not be the cost on the movements.
   * Retryable: the second attempt reads the new average.
   */
  'ORDER_COST_MOVED',
  'CUSTOMER_NOT_FOUND',
  'DELIVERY_ZONE_NOT_FOUND',

  /*
   * Couriers, parcels and settlements (M12, §9, §7; D-006, D-037).
   *
   * Raised by the services and again by migrations 0050 and 0051, so a client
   * branching on the code gets the same answer whichever layer refused — and which
   * layer refuses depends on concurrency, which is exactly the point of
   * `CONSIGNMENT_ALREADY_BOOKED`: two paths enqueueing a booking for one order at
   * once are stopped by the trigger's advisory lock, not by the service.
   *
   * `SETTLEMENT_*` are the ones a person meets. They are separate codes rather than
   * one `SETTLEMENT_INVALID` because the responses differ: a frozen batch means
   * re-import as a new one, an unapproved one means go and find a checker, and a
   * negative net means take it up with the courier.
   */
  'COURIER_ACCOUNT_NOT_FOUND',
  'COURIER_ACCOUNT_INVALID',
  /** The account has no credentials, or the ones it has no longer work. */
  'COURIER_CREDENTIALS_MISSING',
  /** The courier refused the parcel, or did not answer. Retried, then dead-lettered. */
  'COURIER_UNAVAILABLE',
  /** Every retry spent. The order is flagged and `delivery.booking_failed` is raised. */
  'COURIER_BOOKING_FAILED',
  'CONSIGNMENT_NOT_FOUND',
  'CONSIGNMENT_INVALID',
  /** This order already has a parcel with a courier (0050). */
  'CONSIGNMENT_ALREADY_BOOKED',
  /** What a courier collected, and whether it settled, are each recorded once (0051). */
  'CONSIGNMENT_IMMUTABLE',
  /** A courier event is a record of what the courier said; add a new one (0050). */
  'CONSIGNMENT_EVENT_INVALID',
  'CONSIGNMENT_EVENT_IMMUTABLE',
  /** The webhook did not present the secret this account was set up with (§9). */
  'WEBHOOK_SIGNATURE_INVALID',
  /** Only the outcome of processing a stored webhook may change (0050). */
  'WEBHOOK_DELIVERY_IMMUTABLE',
  'SETTLEMENT_NOT_FOUND',
  /** The file could not be parsed, or its columns are not the ones expected. */
  'SETTLEMENT_FILE_INVALID',
  /** The terms were fixed when the approval was raised (0051). */
  'SETTLEMENT_FROZEN',
  /** A settlement's journals exist only once it is posted (0051, §9). */
  'SETTLEMENT_NOT_APPROVED',
  'SETTLEMENT_ALREADY_POSTED',
  'SETTLEMENT_TRANSITION_INVALID',
  /** Charges exceed collections across the whole statement, so no wallet is debited. */
  'SETTLEMENT_OWES_COURIER',
  /** A return receipt that records nothing, or damage with nowhere to put it (§7). */
  'RETURN_RECEIPT_INVALID',
  /** Courier records are the evidence of cash a third party held (0050). */
  'COURIER_RECORD_IMMUTABLE',

  /*
   * Fraud (M13, §10).
   *
   * `ORDER_FRAUD_BLOCKED` is already above: it is the order module's refusal, raised
   * by the state machine, and a client meets it when confirming. These are the fraud
   * module's own, and the split matters — a 409 saying "this buyer is blocked" and a
   * 403 saying "you are not an org_admin so you cannot override" call for opposite
   * responses in the desk.
   */
  /** Somebody without `update FraudOverride` tried to override a block (check 5). */
  'FRAUD_OVERRIDE_UNAUTHORISED',
  /** An override arrived with no reason, or one too short to mean anything. */
  'FRAUD_OVERRIDE_REASON_REQUIRED',
  /** An override is the record of a decision and cannot be changed (0047). */
  'FRAUD_OVERRIDE_IMMUTABLE',
  /** A flag may only be cleared; saying something different means raising a new one (0047). */
  'FRAUD_FLAG_IMMUTABLE',
  'FRAUD_FLAG_NOT_FOUND',
  /** Band floors that do not decrease strictly, so one band could never be reached (D-011). */
  'FRAUD_RULES_INVALID',
  /**
   * A phone signal row is identified by its hash; the key cannot be rewritten (0047).
   *
   * The one unrecoverable corruption in this schema: the cross-org counters have no
   * per-org copy to rebuild from, and the input cannot be recovered to tell which of
   * two plausible rows was right.
   */
  'FRAUD_SIGNAL_KEY_IMMUTABLE',
  /** An order keeps the phone hash it was assessed against (0047). */
  'FRAUD_ORDER_PHONE_IMMUTABLE',

  /*
   * Investors (M25, §15).
   *
   * `INVESTOR_SPLIT_INVALID` is the one worth naming separately from
   * `JOURNAL_UNBALANCED`: a profit split whose parts do not sum to the declared
   * total *would* produce an unbalanced journal, and reporting it that way tells
   * whoever declared it nothing they can act on. The code says the split is
   * wrong, and the message says by how much.
   */
  'INVESTOR_NOT_FOUND',
  /** Capital or profit cannot be moved for an investor who has exited. */
  'INVESTOR_INACTIVE',
  /** An investor's code, login and exit are fixed once set (0060). */
  'INVESTOR_IMMUTABLE',
  'INVESTOR_SPLIT_INVALID',
  /** More was asked for than the investor's capital or unpaid profit holds. */
  'INVESTOR_POSITION_INSUFFICIENT',
  /**
   * The money exists but the lock-in has not ended. Distinct from
   * `INVESTOR_POSITION_INSUFFICIENT`, because "not yet" and "not at all" are
   * different conversations with an investor.
   */
  'INVESTOR_CAPITAL_LOCKED',
  /** A withdrawal's terms are fixed, and it moves only along its own path (0060). */
  'INVESTOR_WITHDRAWAL_FROZEN',
  /** A declared or rejected distribution cannot be changed (0060). */
  'INVESTOR_DISTRIBUTION_FROZEN',
  /** A document must be a stored, private file of the investor-document purpose. */
  'INVESTOR_DOCUMENT_INVALID',

  // Named by §23; owned by later milestones.
  'APPROVAL_REQUIRED',

  /*
   * The HTTP layer's own codes (M04, §23).
   *
   * problem+json needs a `code` for *every* failure, not only the ones a domain
   * module raised, or a client has to branch on the status alone for the rest —
   * and a status is not specific enough to act on: 409 already means both
   * "period closed" and "this idempotency key is still in flight", which call
   * for opposite responses (tell the user vs. retry in a moment).
   */
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  /** The `Idempotency-Key` header is present but unusable (too short, too long). */
  'IDEMPOTENCY_KEY_INVALID',
  /**
   * A key whose first request has not answered yet. Distinct from
   * `IDEMPOTENCY_CONFLICT`, which means the same key arrived with a *different*
   * body: this one is retryable in a moment, that one never is.
   */
  'IDEMPOTENCY_IN_FLIGHT',
  /*
   * HR and payroll (M19, §12).
   *
   * Several of these are raised by migrations 0055 and 0056's triggers as well as by the
   * services, so a client branching on the code gets the same answer whichever layer
   * refused — and which layer refuses depends on concurrency.
   */
  'HR_NOT_FOUND',
  /** That employee has resigned or been terminated. */
  'HR_EMPLOYEE_INACTIVE',
  /** The employee has no salary structure effective in that month. */
  'HR_SALARY_STRUCTURE_MISSING',
  /** A mask column was given something that looks like a full number (invariant 10). */
  'HR_FIELD_NOT_MASKED',
  /** A stored encrypted field could not be read: wrong key, or a tampered row. */
  'HR_FIELD_UNREADABLE',
  'ATTENDANCE_INVALID',
  'ATTENDANCE_IMPORT_REJECTED',
  'ATTENDANCE_IMPORT_FROZEN',
  'PAYROLL_NOT_FOUND',
  /** A posted payroll run cannot be changed; reverse it and post a new one. */
  'PAYROLL_IMMUTABLE',
  'PAYROLL_RUN_FROZEN',
  'PAYROLL_TRANSITION_INVALID',
  /** The approval named is not a server-derived `payroll_run` for this amount. */
  'PAYROLL_APPROVAL_INVALID',
  /** A run's stored totals and its payslips disagree. */
  'PAYROLL_TOTALS_MISMATCH',
  /** Deductions exceed an employee's salary for the month; refused, never clamped. */
  'PAYROLL_NET_NEGATIVE',
  'PAYROLL_STRUCTURE_FROZEN',
  'PAYROLL_LOAN_FROZEN',
  'PAYROLL_LOAN_INVALID',
  'PAYROLL_INPUT_INVALID',
  'PAYROLL_ATTENDANCE_INVALID',
  /*
   * Targets and bonus rules (M20, §12). `TARGET_FROZEN` and `BONUS_RULE_FROZEN` are raised
   * by migration 0082's triggers as well as by the services.
   */
  /** A target's month, metric, people or value is not one that can be set. */
  'TARGET_INVALID',
  /** That employee already has a live target on that metric for that month. */
  'TARGET_CONFLICT',
  /** A target's terms and weekly split are fixed once set; a cancelled one is final. */
  'TARGET_FROZEN',
  /** The bonus rule's JSON is not a rule this system can evaluate. */
  'BONUS_RULE_INVALID',
  /** A submitted or decided bonus rule version cannot change. */
  'BONUS_RULE_FROZEN',

  // Showroom POS (M23)
  'POS_REGISTER_NOT_FOUND',
  'POS_REGISTER_INVALID',
  'POS_SHIFT_NOT_OPEN',
  'POS_SHIFT_ALREADY_OPEN',
  /** A document names a shift that is not the sender's, or not this register's. */
  'POS_SHIFT_MISMATCH',
  'POS_SALE_INVALID',
  'POS_SALE_NOT_FOUND',
  'POS_RETURN_INVALID',
  'POS_REVIEW_NOT_FOUND',
  'POS_REVIEW_RESOLVED',
  /** The person who rang a sale up may not resolve its review item. */
  'POS_REVIEW_SELF_RESOLVE',
  'POS_DISCOUNT_ABOVE_CEILING',
  /** A branch day cannot close while a shift is open or a sale is held. */
  'POS_BRANCH_DAY_NOT_READY',
  'POS_PROMO_UNAVAILABLE',
  'POS_RECORD_IMMUTABLE',

  // Promo codes, notifications and buyer relationships (M16)
  'PROMO_NOT_FOUND',
  /** The code exists but does not apply; the reason is in the message and the body. */
  'PROMO_NOT_APPLICABLE',
  /** Another code of this brand already has that text. */
  'PROMO_CODE_TAKEN',
  'PROMO_INVALID',
  'PROMO_REDEMPTION_IMMUTABLE',
  'NOTIFY_TEMPLATE_INVALID',
  'NOTIFY_MESSAGE_IMMUTABLE',
  'CRM_OCCASION_IMMUTABLE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
