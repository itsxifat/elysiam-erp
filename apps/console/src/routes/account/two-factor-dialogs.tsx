import { Button, Dialog, Skeleton } from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';

import { Alert, Field } from '../../ui/primitives.js';
import {
  confirmNewPhone,
  confirmSetUp,
  newRecoveryCodes,
  startNewPhone,
  startSetUp,
  turnOffTwoFactor,
  type Enrolment,
} from './api.js';
import { digitsOnly, groupKey, keyFromUri, refusalText } from './logic.js';
import { useAccountT } from './messages.js';
import { RecoveryCodes } from './recovery-codes.js';

/**
 * My account's four changes to two-step sign-in (M40, D-694): set it up, move it to a new
 * phone, make new recovery codes, turn it off. Each asks for the password again; the last three
 * ask for the code the authenticator shows now as well (never a recovery code, which the
 * password alone could mint). The server decides whether the change is allowed — these only
 * collect what it asks for.
 */

const TotpQr = lazy(() => import('../../auth/totp-qr.js'));

const CHECKBOX =
  'mt-px size-4 shrink-0 rounded-sm border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

interface DialogProps {
  readonly onClose: () => void;
  /** Called with the sentence the page shows once the change is made. */
  readonly onDone: (message: string) => void | Promise<void>;
}

function Frame({
  title,
  description,
  busy,
  onClose,
  footer,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly footer: ReactNode;
  readonly children: ReactNode;
}) {
  const t = useAccountT();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={title}
      description={description}
      closeLabel={t('account.close')}
      footer={footer}
      className="w-[min(34rem,calc(100vw-2rem))]"
    >
      <div className="space-y-4">{children}</div>
    </Dialog>
  );
}

function PasswordInput({
  id,
  value,
  onChange,
  autoFocus = false,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoFocus?: boolean;
}) {
  const t = useAccountT();
  return (
    <Field
      id={id}
      name="password"
      type="password"
      autoComplete="current-password"
      label={t('account.twoFactor.password')}
      hint={t('account.twoFactor.passwordHint')}
      value={value}
      autoFocus={autoFocus}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function SixDigits({
  id,
  label,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const t = useAccountT();
  return (
    <Field
      id={id}
      name="code"
      label={label}
      hint={t('account.twoFactor.codeFormat')}
      autoComplete="one-time-code"
      inputMode="numeric"
      maxLength={6}
      value={value}
      onChange={(event) => onChange(digitsOnly(event.target.value))}
      className="max-w-48 text-center font-mono text-base tracking-[0.3em] tabular-nums"
    />
  );
}

/** The new secret: a QR code to scan, and the key to type by hand. */
export function AuthenticatorKey({ totpURI }: { readonly totpURI: string }) {
  const t = useAccountT();
  const [copied, setCopied] = useState(false);
  const key = keyFromUri(totpURI);
  return (
    <section className="space-y-3" aria-label={t('account.setup.scan')}>
      <p className="text-sm font-medium text-foreground">{t('account.setup.scan')}</p>
      <div className="flex flex-wrap items-start gap-4">
        <Suspense fallback={<Skeleton className="size-44" />}>
          <TotpQr uri={totpURI} label={t('account.setup.qr')} />
        </Suspense>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs text-muted-foreground">{t('account.setup.manual')}</p>
          <code className="block rounded-md bg-muted px-3 py-2 font-mono text-xs break-all text-foreground">
            {groupKey(key)}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(key).then(() => setCopied(true));
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? t('account.setup.copied') : t('account.setup.copyKey')}
          </Button>
        </div>
      </div>
    </section>
  );
}

// --- set it up ----------------------------------------------------------------------------

export function SetUpDialog({
  brandSlug,
  onClose,
  onDone,
}: DialogProps & { readonly brandSlug: string | null }) {
  const t = useAccountT();
  const [password, setPassword] = useState('');
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => startSetUp(password),
    onSuccess: (result) => {
      setProblem(null);
      setEnrolment(result);
    },
    onError: (cause) => setProblem(refusalText(cause, t)),
  });
  const confirm = useMutation({
    mutationFn: () => confirmSetUp(code),
    onSuccess: () => onDone(t('account.setup.done')),
    onError: (cause) => setProblem(refusalText(cause, t)),
  });
  const busy = start.isPending || confirm.isPending;

  return (
    <Frame
      title={t('account.setup.title')}
      description={t('account.setup.detail')}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('account.cancel')}
          </Button>
          {enrolment === null ? (
            <Button disabled={busy || password === ''} onClick={() => start.mutate()}>
              {t('account.continue')}
            </Button>
          ) : (
            <Button disabled={busy || !saved || code.length !== 6} onClick={() => confirm.mutate()}>
              {t('account.done')}
            </Button>
          )}
        </>
      }
    >
      {enrolment === null ? (
        <PasswordInput id="setup-password" value={password} onChange={setPassword} autoFocus />
      ) : (
        <>
          <AuthenticatorKey totpURI={enrolment.totpURI} />
          <section className="space-y-2">
            <p className="text-sm font-medium text-foreground">{t('account.setup.codesTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('account.setup.codesDetail')}</p>
            <RecoveryCodes codes={enrolment.backupCodes} brandSlug={brandSlug} />
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className={CHECKBOX}
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              <span>{t('account.setup.acknowledge')}</span>
            </label>
          </section>
          <SixDigits
            id="setup-code"
            label={t('account.setup.enterCode')}
            value={code}
            onChange={setCode}
          />
        </>
      )}
      {problem === null ? null : <Alert>{problem}</Alert>}
    </Frame>
  );
}

// --- a new phone --------------------------------------------------------------------------

export function NewPhoneDialog({ onClose, onDone }: DialogProps) {
  const t = useAccountT();
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [totpURI, setTotpURI] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const start = useMutation({
    mutationFn: () => startNewPhone(password, current),
    onSuccess: (result) => {
      setProblem(null);
      setPassword('');
      setTotpURI(result.totpURI);
    },
    onError: (cause) => setProblem(refusalText(cause, t)),
  });
  const confirm = useMutation({
    mutationFn: () => confirmNewPhone(code),
    onSuccess: () => onDone(t('account.newPhone.done')),
    onError: (cause) => setProblem(refusalText(cause, t)),
  });
  const busy = start.isPending || confirm.isPending;

  return (
    <Frame
      title={t('account.newPhone.title')}
      description={totpURI === null ? t('account.newPhone.detail') : t('account.newPhone.step2')}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {t('account.cancel')}
          </Button>
          {totpURI === null ? (
            <Button
              disabled={busy || password === '' || current.length !== 6}
              onClick={() => start.mutate()}
            >
              {t('account.continue')}
            </Button>
          ) : (
            <Button disabled={busy || code.length !== 6} onClick={() => confirm.mutate()}>
              {t('account.done')}
            </Button>
          )}
        </>
      }
    >
      {totpURI === null ? (
        <>
          <PasswordInput id="phone-password" value={password} onChange={setPassword} autoFocus />
          <SixDigits
            id="phone-current"
            label={t('account.twoFactor.currentCode')}
            value={current}
            onChange={setCurrent}
          />
        </>
      ) : (
        <>
          <AuthenticatorKey totpURI={totpURI} />
          <SixDigits
            id="phone-code"
            label={t('account.setup.enterCode')}
            value={code}
            onChange={setCode}
          />
        </>
      )}
      {problem === null ? null : <Alert>{problem}</Alert>}
    </Frame>
  );
}

// --- new recovery codes -------------------------------------------------------------------

export function NewCodesDialog({
  brandSlug,
  onClose,
  onDone,
}: DialogProps & { readonly brandSlug: string | null }) {
  const t = useAccountT();
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const make = useMutation({
    mutationFn: () => newRecoveryCodes(password, current),
    onSuccess: (result) => {
      setProblem(null);
      setPassword('');
      setCurrent('');
      setCodes(result.backupCodes);
    },
    onError: (cause) => setProblem(refusalText(cause, t)),
  });

  return (
    <Frame
      title={t('account.newCodes.title')}
      description={codes === null ? t('account.newCodes.detail') : t('account.setup.codesDetail')}
      busy={make.isPending}
      onClose={codes === null ? onClose : () => void onDone(t('account.newCodes.done'))}
      footer={
        codes === null ? (
          <>
            <Button variant="outline" disabled={make.isPending} onClick={onClose}>
              {t('account.cancel')}
            </Button>
            <Button
              disabled={make.isPending || password === '' || current.length !== 6}
              onClick={() => make.mutate()}
            >
              {t('account.continue')}
            </Button>
          </>
        ) : (
          <Button onClick={() => void onDone(t('account.newCodes.done'))}>
            {t('account.done')}
          </Button>
        )
      }
    >
      {codes === null ? (
        <>
          <PasswordInput id="codes-password" value={password} onChange={setPassword} autoFocus />
          <SixDigits
            id="codes-current"
            label={t('account.twoFactor.currentCode')}
            value={current}
            onChange={setCurrent}
          />
        </>
      ) : (
        <RecoveryCodes codes={codes} brandSlug={brandSlug} />
      )}
      {problem === null ? null : <Alert>{problem}</Alert>}
    </Frame>
  );
}

// --- turn it off --------------------------------------------------------------------------

export function TurnOffDialog({ onClose, onDone }: DialogProps) {
  const t = useAccountT();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const off = useMutation({
    mutationFn: () => turnOffTwoFactor(password, code),
    onSuccess: () => onDone(t('account.turnOff.done')),
    onError: (cause) => setProblem(refusalText(cause, t)),
  });

  return (
    <Frame
      title={t('account.turnOff.title')}
      description={t('account.turnOff.detail')}
      busy={off.isPending}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={off.isPending} onClick={onClose}>
            {t('account.cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={off.isPending || password === '' || code.length !== 6}
            onClick={() => off.mutate()}
          >
            {t('account.twoFactor.turnOff')}
          </Button>
        </>
      }
    >
      <PasswordInput id="off-password" value={password} onChange={setPassword} autoFocus />
      <SixDigits
        id="off-code"
        label={t('account.twoFactor.currentCode')}
        value={code}
        onChange={setCode}
      />
      {problem === null ? null : <Alert>{problem}</Alert>}
    </Frame>
  );
}
