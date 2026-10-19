/**
 * @elysium/i18n
 *
 * The English messages, plus the money, date and number formatters every surface
 * shares (architecture §4, §24; D-750: English only).
 *
 * The package is deliberately four small modules behind this barrel rather than
 * one file:
 *
 * - `locale.ts`   which locales exist, and which one each audience gets
 * - `locales/*`   the catalogue and its sections, English only (D-750)
 * - `digits.ts`   lakh/crore grouping, used by money and counts alike
 * - `money.ts`, `dates.ts`  the formatters
 *
 * M02a seeded the catalogue with the login flow's strings, because the UI rule
 * is that *every* string goes through here and the first screen is no
 * exception. M03 added `formatMoney`. M04 splits the catalogue out, adds the
 * date helpers, and adds `scripts/check-i18n.mjs` — the missing-key check this
 * shape was designed for, and the second half of acceptance check 6.
 *
 * Nothing here has a runtime fallback to the key itself. A missing key is a
 * build error or a checker failure, never a screen that says `auth.signIn` to
 * whoever happened to open it.
 */

import { DEFAULT_LOCALE, type Locale } from './locale.js';
import { en, type MessageKey as CoreMessageKey } from './locales/en.js';
import {
  en as catalogPricingEn,
  type CatalogPricingKey,
} from './locales/sections/catalog-pricing.en.js';
import { en as packingEn, type PackingKey } from './locales/sections/packing.en.js';
import { en as packStationEn, type PackStationKey } from './locales/sections/pack-station.en.js';
import { en as stockToolsEn, type StockToolsKey } from './locales/sections/stock-tools.en.js';
import { en as webMarketingEn, type WebMarketingKey } from './locales/sections/web-marketing.en.js';
import { en as websiteEn, type WebsiteKey } from './locales/sections/website.en.js';
import { en as manageEn, type ManageKey } from './locales/sections/manage.en.js';
import { en as trustEn, type TrustKey } from './locales/sections/trust.en.js';
import { en as accountEn, type AccountKey } from './locales/sections/account.en.js';
import { en as inboxEn, type InboxKey } from './locales/sections/inbox.en.js';
import { en as inboxSellEn, type InboxSellKey } from './locales/sections/inbox-sell.en.js';
import { en as workflowEn, type WorkflowKey } from './locales/sections/workflow.en.js';
import { en as aliveEn, type AliveKey } from './locales/sections/alive.en.js';
import { en as voiceEn, type VoiceKey } from './locales/sections/voice.en.js';
import { en as labelsEn, type LabelsKey } from './locales/sections/labels.en.js';
import { en as posEn, type PosKey } from './locales/sections/pos.en.js';
import { en as telephonyEn, type TelephonyKey } from './locales/sections/telephony.en.js';
import { en as peopleEn, type PeopleKey } from './locales/sections/people.en.js';

export { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from './locale.js';

export { formatCount, groupSouthAsian } from './digits.js';
export { formatMoney, formatMoneyText, type FormatMoneyOptions } from './money.js';
export {
  BUSINESS_TIME_ZONE,
  businessDate,
  formatDate,
  formatDateTime,
  formatMonth,
  formatTime,
  today,
  type DateStyle,
  type FormatDateOptions,
  type IsoDate,
} from './dates.js';

/**
 * Every key that exists: the core catalogue's and every section's (M38a, D-607).
 *
 * A section is one area's strings in its own file (`locales/sections/<area>.<locale>.ts`),
 * typed exactly like the core one, so the console can ship it with that area's screens
 * instead of in the first download. On the server, and in `messages`, it is simply part of
 * its locale.
 */
export type MessageKey =
  | CoreMessageKey
  | StockToolsKey
  | WebsiteKey
  | CatalogPricingKey
  | ManageKey
  | WebMarketingKey
  | PackingKey
  | PackStationKey
  | TrustKey
  | AccountKey
  | InboxKey
  | InboxSellKey
  | WorkflowKey
  | AliveKey
  | VoiceKey
  | LabelsKey
  | PosKey
  | TelephonyKey
  | PeopleKey;
export type {
  AccountKey,
  AliveKey,
  InboxKey,
  LabelsKey,
  PosKey,
  PeopleKey,
  TelephonyKey,
  InboxSellKey,
  WorkflowKey,
  VoiceKey,
  CatalogPricingKey,
  CoreMessageKey,
  ManageKey,
  PackingKey,
  PackStationKey,
  StockToolsKey,
  TrustKey,
  WebMarketingKey,
  WebsiteKey,
};

/**
 * The catalogue, by locale: English, the one locale (D-750).
 *
 * Exported because the console hands the whole map to its provider once rather
 * than calling `t()` through a closure, and because the checker and the parity
 * test read it. Frozen shallowly at the type level only — these are `const`
 * object literals, so a mutation is a compile error rather than a runtime
 * surprise in one process and not another.
 */
export const messages: Record<Locale, Record<MessageKey, string>> = {
  en: {
    ...en,
    ...stockToolsEn,
    ...websiteEn,
    ...catalogPricingEn,
    ...manageEn,
    ...webMarketingEn,
    ...packingEn,
    ...packStationEn,
    ...trustEn,
    ...accountEn,
    ...inboxEn,
    ...inboxSellEn,
    ...workflowEn,
    ...aliveEn,
    ...voiceEn,
    ...labelsEn,
    ...posEn,
    ...telephonyEn,
    ...peopleEn,
  },
};

/**
 * Look a message up.
 *
 * The key type makes a missing key a compile error, so there is no default and
 * no interpolation of the key into the output. Interpolation of *values* is not
 * here either: a message that needs a number or a name should be assembled by
 * the caller from a formatter, because the alternative — a template syntax —
 * puts logic in a translation file where no test can reach it.
 */
export function t(key: MessageKey, locale: Locale = DEFAULT_LOCALE): string {
  return messages[locale][key];
}
