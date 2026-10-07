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
  /**
   * A barcode the catalog will not take (M38a, D-603): one in the range the ERP numbers
   * its own SKUs from (`2` and twelve digits), typed by hand.
   */
  'CATALOG_BARCODE_INVALID',
  /**
   * A sticker request the layout cannot print: too many, a position off the sheet, or a
   * custom size too small to hold a barcode a scanner reads (D-650).
   */
  'CATALOG_LABELS_INVALID',
  /**
   * Variants that cannot be archived together because stock is held for orders (M39b,
   * D-639): archiving would leave confirmed orders holding pieces nobody may sell or edit.
   */
  'CATALOG_SKU_HELD',
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
   * Stock in hand at the start and the opening stock window (M38a, D-602). Raised by the
   * service and again by the M38a policies migration's triggers, for the reason above.
   */
  /** The brand's opening stock window is closed: stock now arrives only from suppliers. */
  'OPENING_STOCK_CLOSED',
  /** A change to the window other than closing it or an approved reopen. */
  'OPENING_STOCK_INVALID',
  /** Reopening named no approval, or one not approved after the close. */
  'OPENING_STOCK_REOPEN_UNAPPROVED',
  /** A request to reopen the window is already waiting for a checker. */
  'OPENING_STOCK_REOPEN_PENDING',
  'STOCK_IN_HAND_NOT_FOUND',
  'STOCK_IN_HAND_INVALID',
  /** A posted stock-in-hand entry, or its lines, cannot change. */
  'STOCK_IN_HAND_IMMUTABLE',
  /** A stock-in-hand line has no cost per piece, and every line needs one to post. */
  'STOCK_IN_HAND_COST_REQUIRED',
  /** The draft's pieces or location changed after the person posting it read it. */
  'STOCK_IN_HAND_CHANGED',
  /**
   * A posted entry cannot be reversed now: a reversal is already waiting, or its pieces
   * have since been costed with other stock or have left the location.
   */
  'STOCK_IN_HAND_REVERSAL_BLOCKED',
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
  /** A standard buying price file with problems (M39b, D-638): nothing was imported. */
  'SUPPLY_IMPORT_REJECTED',

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
  /** §9's COD formula refused: a negative result, or a discount beyond the items. */
  'ORDER_TOTAL_INVALID',
  'ORDER_LINES_INVALID',
  'ORDER_PHONE_INVALID',
  /**
   * M30: the order is priced further below the catalogue than the caller's role may go
   * (D-364). An org admin enters it, or the agent asks for less.
   */
  'ORDER_DISCOUNT_ABOVE_CEILING',
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
  /**
   * A return or an exchange was given no reason from the fixed list (M17, D-234). Raised by
   * the domain state machine, and by migration 0088's deferred trigger at commit.
   */
  'ORDER_RETURN_REASON_REQUIRED',

  /*
   * Advances against an order (M17, §7; D-013, D-230 to D-233).
   *
   * An agent records a claim and accounts verifies it. A duplicate reference and a
   * self-verification are kept apart because they call for different people: the agent
   * re-checks the SMS, or a second person verifies.
   */
  'ADVANCE_NOT_FOUND',
  /** The claim is not in a state for this action, or the order no longer takes one. */
  'ADVANCE_INVALID',
  /** That transaction reference already backs a live claim in this brand. */
  'ADVANCE_DUPLICATE',
  /** The person who recorded a claim cannot also verify it. */
  'ADVANCE_SELF_VERIFY',
  /**
   * The parcel is booked or on the road, and its COD is the one the courier was given.
   * Verify once the booking is cancelled or the order has ended.
   */
  'ADVANCE_PARCEL_IN_FLIGHT',
  /** A claim's terms are fixed, and its status moves only along its own path (0088). */
  'ADVANCE_IMMUTABLE',

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
   * by migration 0091's triggers as well as by the services.
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
  /**
   * M30: money for oneself, or paying out what one recorded. A staff loan to yourself, the
   * disbursal of a loan you recorded, or your own payout account is done by a second person.
   */
  'PAYROLL_SELF_DEALING',

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
  // Flash sales (M35a)
  'FLASH_SALE_NOT_FOUND',
  /** A claim refused: sold out, not live, switched off, or the sale price moved. */
  'FLASH_SALE_UNAVAILABLE',
  /** Another sale of this brand already has that slug. */
  'FLASH_SALE_SLUG_TAKEN',
  'FLASH_SALE_INVALID',
  'FLASH_CLAIM_IMMUTABLE',
  'NOTIFY_TEMPLATE_INVALID',
  'NOTIFY_MESSAGE_IMMUTABLE',
  'CRM_OCCASION_IMMUTABLE',

  // Data migration and opening balances (M14a)
  /** A file with a problem in it, or with nothing new to import. Nothing was changed. */
  'MIGRATION_IMPORT_REJECTED',
  /** An imported file is discarded or posted once and never changes otherwise (0082). */
  'MIGRATION_BATCH_IMMUTABLE',
  /** The opening of a brand's books is permanent; only its sign-off is set, once (0082). */
  'MIGRATION_OPENING_IMMUTABLE',
  /** This brand's books are already open, so balance files are closed (D-213). */
  'MIGRATION_ALREADY_OPENED',
  'MIGRATION_NOT_FOUND',
  /** A sign-off needs a posted opening whose reconciliation agrees on every line. */
  'MIGRATION_NOT_RECONCILED',

  // Marketing (M18, §11)
  'MARKETING_INVALID',
  'MARKETING_CAMPAIGN_NOT_FOUND',
  /** That Meta id or `utm_campaign` already names another of this brand's campaigns. */
  'MARKETING_REF_TAKEN',
  'MARKETING_LEAD_NOT_FOUND',
  /** A spend figure keeps its campaign and day, and the import never replaces a person's. */
  'MARKETING_SPEND_IMMUTABLE',
  /** A sent or skipped conversion is final. */
  'MARKETING_CAPI_IMMUTABLE',
  /** The brand has no Meta ad account, pixel or token set up for what was asked. */
  'MARKETING_META_NOT_CONNECTED',
  /** This installation has no key to seal a Meta token with. */
  'MARKETING_CREDENTIALS_MISSING',

  // Analytics (M24, §18)
  'ANALYTICS_INVALID',
  /** The narrative provider did not answer, or answered with nothing usable. Nothing was cached. */
  'ANALYTICS_NARRATIVE_FAILED',

  // Company loans (M26, §15)
  'LOAN_NOT_FOUND',
  'LOAN_LENDER_NOT_FOUND',
  /** Terms that are not a loan, or that leave an instalment with nothing to pay (D-294). */
  'LOAN_TERMS_INVALID',
  /** A loan's instalments are not its tenure, or do not sum to its principal (0095). */
  'LOAN_SCHEDULE_INVALID',
  /** Not the next unpaid instalment, already paid or waiting, or not as scheduled (D-297). */
  'LOAN_PAYMENT_INVALID',
  /** A loan, its schedule and its reminders are a record; a payment moves once (0095). */
  'LOAN_IMMUTABLE',
  /** The person who recorded a loan cannot also void it; a second person does (D-304). */
  'LOAN_SELF_VOID',

  // The brand's website, run from its ERP (M33, D-500 to D-519)
  /** No such website item (slide, menu item, size chart, site key) in this brand. */
  'STOREFRONT_NOT_FOUND',
  /** A website setting or item the rules refuse: a menu three deep, a zone in two places. */
  'STOREFRONT_INVALID',
  /** A size chart that products still point at. */
  'STOREFRONT_IN_USE',

  // Buying on the website (M34, D-520 to D-539)
  /** A figure moved between the quote the shopper saw and the checkout; the body has the new quote. */
  'CART_REPRICED',
  /** The web locations cannot hold every line any more; the body names the lines. */
  'OUT_OF_STOCK',
  /** The website does not ship to that address (its district and thana fall in no zone it serves). */
  'CART_NOT_DELIVERABLE',
  /** That way of paying is switched off for this website, or not set up. */
  'PAYMENT_METHOD_UNAVAILABLE',
  /** The order is not waiting for an online payment: paid, cancelled or cash on delivery. */
  'PAYMENT_NOT_PAYABLE',
  /** The payment gateway did not answer, or refused to open a session. Nothing was charged. */
  'PAYMENT_GATEWAY_FAILED',
  /** An account already uses that email address. */
  'ACCOUNT_EXISTS',
  /** No account with that email and password; one sentence for both (D-522). */
  'ACCOUNT_CREDENTIALS_INVALID',
  /** The account's email address is not verified yet. */
  'ACCOUNT_EMAIL_UNVERIFIED',
  /** A wrong, used, expired or burnt email code, or a reset link that is not live. */
  'ACCOUNT_CODE_INVALID',
  /** No such shopper account in this brand. */
  'ACCOUNT_NOT_FOUND',
  /** The account signs in with Google only and has no password to change. */
  'ACCOUNT_NO_PASSWORD',
  /** That email's account is linked to a different Google login. */
  'ACCOUNT_GOOGLE_CONFLICT',
  /** STOREFRONT_CREDENTIALS_KEY is not set, so gateway and email credentials cannot be kept. */
  'WEBSITE_CREDENTIALS_MISSING',
  /** The brand's email server is not set up or is switched off. */
  'EMAIL_NOT_CONFIGURED',
  /** The email server refused or did not answer. */
  'EMAIL_SEND_FAILED',

  // Staff accounts and sign-in (gaps-users-auth, D-400 to D-409)
  /** No such person holds or held a role in this organization. */
  'USER_NOT_FOUND',
  /** Nobody changes their own roles, deactivates themselves or resets their own sign-in. */
  'USER_SELF_MANAGEMENT',
  /** A super admin, or someone in more than one brand: only a super admin acts on them. */
  'USER_PROTECTED',
  /** The person has been deactivated in this organization. */
  'USER_INACTIVE',
  /** A reset of this kind is already waiting for approval or collection. */
  'CREDENTIAL_RESET_PENDING',
  /** There is nothing to reset: no second factor is enrolled. */
  'CREDENTIAL_NOTHING_TO_RESET',
  /**
   * A trust vote that would not count (D-656): the voter is not an admin with two-step
   * sign-in, or is in the person's invitation chain, or shares an inviter with them.
   */
  'TRUST_VOTE_REFUSED',
  /** Only an active admin of the brand, not a super admin, is vouched for (D-654). */
  'TRUST_NOT_CANDIDATE',
  /**
   * Only an active admin of the brand who is not a super admin or an owner can be made a
   * super admin (D-659); or there is no nomination for them to withdraw.
   */
  'SUPER_ADMIN_NOT_CANDIDATE',
  /**
   * Sent by sign-in itself (Better Auth's error body), not by a route here: the account
   * is disabled, or holds no active role in any brand (D-401).
   */
  'ACCOUNT_INACTIVE',

  /*
   * Delete and archive everywhere (M39a, D-621 to D-634).
   *
   * Each module's "something still uses this row": the delete asked every module that points
   * at it (the `CatalogReferences` port and its siblings) and one answered, or the database's
   * foreign key refused it (23503) as the backstop. The detail names the counts in words;
   * `GET …/usage` names them as data, and the screen offers Archive instead.
   */
  /** A category, list, value, product or variant that stock, orders or the website use. */
  'CATALOG_IN_USE',
  /** A stock location that holds, held or moved stock, or that a till, order or supply names. */
  'INVENTORY_IN_USE',
  /** A supplier with entries, returns, payments or notes. */
  'SUPPLY_IN_USE',
  /** A discount that was redeemed or named on an order, or a flash sale that sold. */
  'PROMO_IN_USE',
  /** An SMS template that was sent, or one the system sends by itself. */
  'NOTIFY_IN_USE',
  /** An ad campaign with spend, leads or discounts. */
  'MARKETING_IN_USE',
  /** A branch that still has an open till, money, staff or stock, so it is not switched off. */
  'BRANCH_IN_USE',
  // M35b: campaign links, tracking, the marketplace connector, the scanner, order labels
  /** Every five-digit code was taken on each try; try again. */
  'CAMPAIGN_LINK_CODE_EXHAUSTED',
  /** The marketplace connector is not set up, or this action needs a credential it lacks. */
  'MARKETPLACE_NOT_CONFIGURED',
  /** The scanner sign-in's email or password is wrong (one answer for both). */
  'SCANNER_CREDENTIALS_INVALID',
  /** The account has two-step sign-in on: send the authenticator's code, or pair from the console. */
  'SCANNER_CODE_REQUIRED',
  /** The account must enrol two-step sign-in in the console before a phone can sign in. */
  'SCANNER_ENROLMENT_REQUIRED',
  /** The account holds roles in more than one brand: pair the phone from the console. */
  'SCANNER_BRAND_AMBIGUOUS',
  /** The account may not read orders, so it cannot pack. */
  'SCANNER_NOT_ALLOWED',
  /** No order has that order number, tracking code or consignment id. */
  'SHIPMENT_NOT_FOUND',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
