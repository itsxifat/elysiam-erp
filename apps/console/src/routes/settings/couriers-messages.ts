import type { MessageKey } from '@elysium/i18n';

// First, so the courier section is registered before `sectionCatalogue` reads it (D-906).
import '../../i18n/courier.js';
import { sectionCatalogue } from '../../i18n/messages.js';
import { useLocale } from '../../i18n/locale.js';

/**
 * The strings Settings → Couriers renders (D-913).
 *
 * They live in the courier section (`packages/i18n/src/locales/sections/courier.en.ts`), which
 * travels in this lazy screen's chunk rather than in the console's first download. The older
 * advanced fields keep their `settings.couriers.*` keys, read through `useSettingsT`.
 */
const COURIER_SETUP_KEYS = [
  'courier.setup.caption',
  'courier.setup.readOnly',
  'courier.setup.add',
  'courier.setup.emptyTitle',
  'courier.setup.emptyDetail',
  'courier.setup.state.connected',
  'courier.setup.state.notConnected',
  'courier.setup.state.panel',
  'courier.setup.state.off',
  'courier.setup.default',
  'courier.setup.makeDefault',
  'courier.setup.changeKeys',
  'courier.setup.connect',
  'courier.setup.advanced',
  'courier.setup.advancedSave',
  'courier.setup.advancedSaved',
  'courier.setup.chooseTitle',
  'courier.setup.chooseDescription',
  'courier.setup.choiceApi',
  'courier.setup.choicePanel',
  'courier.setup.choiceOff',
  'courier.setup.connectTitle',
  'courier.setup.addTitle',
  'courier.setup.keysTitle',
  'courier.setup.keysDescription',
  'courier.setup.keysNeverShown',
  'courier.setup.panelNote',
  'courier.setup.useDefault',
  'courier.setup.useDefaultHint',
  'courier.setup.keysForDefault',
  'courier.setup.defaultWarnMixed',
  'courier.setup.defaultWarnReplaces',
  'courier.setup.defaultNotAllowed',
  'courier.setup.back',
  'courier.setup.checking',
  'courier.setup.connected',
  'courier.setup.added',
  'courier.setup.madeDefault',
  'courier.setup.missing',
  'courier.setup.pairNeeded',
  'courier.setup.optionalLogin',
  'courier.setup.couldNotSave',
  'courier.setup.unknownCourier',
  'courier.setup.field.apiKey',
  'courier.setup.field.secretKey',
  'courier.setup.field.clientId',
  'courier.setup.field.clientSecret',
  'courier.setup.field.storeId',
  'courier.setup.field.username',
  'courier.setup.field.password',
  'courier.setup.field.accessToken',
] as const satisfies readonly MessageKey[];

export type CourierSetupKey = (typeof COURIER_SETUP_KEYS)[number];

export const courierSetupMessages = sectionCatalogue(COURIER_SETUP_KEYS);

export function useCourierSetupT(): (key: CourierSetupKey) => string {
  const { locale } = useLocale();
  return (key) => courierSetupMessages[locale][key];
}

/** A string with `{name}` in it, filled. Every `{name}` in it, since some say it twice. */
export function withName(text: string, name: string): string {
  return text.replaceAll('{name}', name);
}
