import { StatusBadge } from '@elysium/ui';
import type { BrandStatusWire } from '@elysium/mother-shared';

import { useLocale, type MessageKey } from '../i18n/locale.js';
import { age } from './format.js';

/**
 * How fresh a brand's figures are, and why not when they are not (D-486): the age of the
 * last good read, and a labelled badge when the last attempt failed. Colour is never the
 * only signal; every badge carries its word.
 */

const ERROR_KEYS: Readonly<Record<string, MessageKey>> = {
  unreachable: 'brandError.unreachable',
  timeout: 'brandError.timeout',
  auth_failed: 'brandError.auth_failed',
  database_missing: 'brandError.database_missing',
  permission_denied: 'brandError.permission_denied',
  version_mismatch: 'brandError.version_mismatch',
  brand_not_found: 'brandError.brand_not_found',
  training_org: 'brandError.training_org',
  secrets_key: 'brandError.secrets_key',
  read_failed: 'brandError.read_failed',
  inactive: 'brandError.inactive',
  ok: 'brandError.ok',
};

export function brandErrorKey(code: string): MessageKey {
  return ERROR_KEYS[code] ?? 'brandError.read_failed';
}

export function useAge(): (iso: string) => string {
  const { t, locale } = useLocale();
  return (iso: string) =>
    age(
      iso,
      new Date(),
      {
        justNow: t('age.justNow'),
        minutes: t('age.minutes'),
        hours: t('age.hours'),
        days: t('age.days'),
      },
      locale,
    );
}

export function BrandFreshness({ brand }: { readonly brand: BrandStatusWire }) {
  const { t } = useLocale();
  const ageOf = useAge();
  if (!brand.isActive) return <StatusBadge tone="neutral">{t('status.inactive')}</StatusBadge>;
  const failing =
    brand.lastError !== null && (brand.figuresAt === null || brand.lastError.at > brand.figuresAt);
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {brand.figuresAt === null ? (
        <span>{t('status.never')}</span>
      ) : (
        <span>
          {t('status.updated')} {ageOf(brand.figuresAt)}
        </span>
      )}
      {brand.schema === 'version_mismatch' ? (
        <StatusBadge tone="warning">{t('status.versionMismatch')}</StatusBadge>
      ) : failing ? (
        <span title={t(brandErrorKey(brand.lastError?.code ?? 'read_failed'))}>
          <StatusBadge tone="danger">{t('status.error')}</StatusBadge>
        </span>
      ) : null}
    </span>
  );
}
