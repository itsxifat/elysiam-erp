import { Button } from '@elysium/ui';

import { useT } from '../../i18n/locale.js';
import '../../i18n/web-marketing.js';
import { control, Field } from './parts.js';

/**
 * Pieces the M35b Website screens share (campaign links, tracking, marketplace).
 *
 * A write-only secret: the stored one is kept unless a new one is typed or it is removed. The
 * server answers with a fingerprint, never the secret.
 */
export type Secret =
  | { readonly mode: 'keep' }
  | { readonly mode: 'set'; readonly value: string }
  | { readonly mode: 'remove' };

/** What a save sends: undefined keeps the stored secret, null removes it. */
export function secretField(secret: Secret): string | null | undefined {
  if (secret.mode === 'keep') return undefined;
  if (secret.mode === 'remove') return null;
  return secret.value.trim() === '' ? undefined : secret.value.trim();
}

/** A write-only secret: keep the stored one, type a new one, or remove it. */
export function SecretInput({
  id,
  label,
  fingerprint,
  secret,
  onChange,
  maxLength,
  disabled = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly fingerprint: string | null;
  readonly secret: Secret;
  readonly onChange: (next: Secret) => void;
  readonly maxLength: number;
  readonly disabled?: boolean;
}) {
  const t = useT();
  const hint =
    secret.mode === 'remove'
      ? t('wm.secret.removing')
      : fingerprint === null
        ? t('wm.secret.none')
        : `${t('wm.secret.set')} ${fingerprint}`;
  return (
    <Field id={id} label={label} hint={hint}>
      <div className="flex gap-2">
        <input
          id={id}
          type="password"
          value={secret.mode === 'set' ? secret.value : ''}
          maxLength={maxLength}
          autoComplete="new-password"
          disabled={disabled}
          className={control}
          onChange={(event) =>
            onChange(
              event.target.value === ''
                ? { mode: 'keep' }
                : { mode: 'set', value: event.target.value },
            )
          }
        />
        {fingerprint === null ? null : (
          <Button
            size="sm"
            variant="outline"
            type="button"
            disabled={disabled}
            aria-pressed={secret.mode === 'remove'}
            onClick={() =>
              onChange(secret.mode === 'remove' ? { mode: 'keep' } : { mode: 'remove' })
            }
          >
            {secret.mode === 'remove' ? t('wm.secret.keep') : t('wm.remove')}
          </Button>
        )}
      </div>
    </Field>
  );
}
