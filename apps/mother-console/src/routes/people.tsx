import {
  Button,
  ConfirmDialog,
  DateTime,
  Dialog,
  ErrorState,
  PageHeader,
  Section,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { inviteOwnerSchema, type LinkWire, type PersonWire } from '@elysium/mother-shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, UserPlus } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { ApiError, endpoints } from '../api.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';
import { useMe } from '../session.js';
import { Alert, Field } from '../ui/primitives.js';

/**
 * The owners (M32 screen 6; D-487 to D-489): invite one (the link is handed to the owner
 * who asked, to pass on), remove one, and reset a lost second factor — which a third owner
 * approves. The server enforces every rule; the screen only offers what may work.
 */

const PEOPLE_KEY = ['people'] as const;

const ERRORS: Readonly<Record<string, MessageKey>> = {
  EMAIL_TAKEN: 'people.error.EMAIL_TAKEN',
  LAST_OWNER: 'people.error.LAST_OWNER',
  RESET_NOT_DECIDABLE: 'people.error.RESET_NOT_DECIDABLE',
  SELF_ACTION_REFUSED: 'people.error.SELF_ACTION_REFUSED',
  CONFLICT: 'people.error.CONFLICT',
};

function errorKey(cause: unknown): MessageKey {
  if (cause instanceof ApiError && cause.code !== null) {
    return ERRORS[cause.code] ?? 'common.errorDetail';
  }
  return 'common.errorDetail';
}

export function PeoplePage() {
  const { t } = useLocale();
  const me = useMe();
  const queryClient = useQueryClient();
  const people = useQuery({ queryKey: PEOPLE_KEY, queryFn: endpoints.people });
  const [inviting, setInviting] = useState(false);
  const [link, setLink] = useState<LinkWire | null>(null);
  const [removing, setRemoving] = useState<PersonWire | null>(null);
  const [resetting, setResetting] = useState<PersonWire | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: PEOPLE_KEY });

  const reissue = useMutation({
    mutationFn: (id: string) => endpoints.reissueInvite(id),
    onSuccess: (result) => setLink(result),
    onError: (cause) => setError(errorKey(cause)),
  });
  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'approve' | 'reject' }) =>
      endpoints.decideReset(input.id, input.decision),
    onSuccess: () => refresh(),
    onError: (cause) => setError(errorKey(cause)),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('people.title')}
        description={t('people.description')}
        actions={
          <Button size="sm" onClick={() => setInviting(true)}>
            <UserPlus aria-hidden="true" />
            {t('people.invite')}
          </Button>
        }
      />
      {error === null ? null : <Alert>{t(error)}</Alert>}
      {people.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : people.isError ? (
        <ErrorState title={t('common.error')} detail={t('common.errorDetail')} />
      ) : (
        <>
          <Section title={t('people.title')} bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <caption className="sr-only">{t('people.title')}</caption>
                <thead>
                  <tr className="border-y border-border text-xs text-muted-foreground">
                    <th scope="col" className="px-5 py-2 text-left font-medium">
                      {t('people.name')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      {t('people.status')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      {t('people.twoFactor')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      {t('people.lastSignIn')}
                    </th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">
                      {t('people.actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {people.data.people.map((person) => {
                    const self = person.id === me.id;
                    return (
                      <tr key={person.id} className="border-b border-border last:border-0">
                        <th scope="row" className="px-5 py-2.5 text-left font-normal">
                          <span className="font-medium">{person.name}</span>
                          {self ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              ({t('people.you')})
                            </span>
                          ) : null}
                          <span className="block text-xs text-muted-foreground">
                            {person.email}
                          </span>
                        </th>
                        <td className="px-3 py-2.5">
                          <StatusBadge
                            tone={
                              !person.isActive ? 'neutral' : person.hasPassword ? 'success' : 'info'
                            }
                          >
                            {!person.isActive
                              ? t('people.removed')
                              : person.hasPassword
                                ? t('people.active')
                                : t('people.invited')}
                          </StatusBadge>
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusBadge tone={person.twoFactorEnabled ? 'success' : 'warning'}>
                            {person.twoFactorEnabled ? t('people.on') : t('people.off')}
                          </StatusBadge>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {person.lastSignInAt === null ? (
                            t('people.never')
                          ) : (
                            <DateTime value={person.lastSignInAt} compact />
                          )}
                        </td>
                        <td className="px-5 py-2.5">
                          <div className="flex justify-end gap-1">
                            {person.isActive && !person.hasPassword ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => reissue.mutate(person.id)}
                              >
                                {t('people.resend')}
                              </Button>
                            ) : null}
                            {person.isActive && person.twoFactorEnabled && !self ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setResetting(person)}
                              >
                                {t('people.resetTwoFactor')}
                              </Button>
                            ) : null}
                            {person.isActive && !self ? (
                              <Button variant="ghost" size="sm" onClick={() => setRemoving(person)}>
                                {t('people.remove')}
                              </Button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>

          <Section
            title={t('people.resets')}
            description={t('people.resetsHint')}
            bodyClassName="p-0"
          >
            {people.data.resets.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-muted-foreground">{t('people.noResets')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <caption className="sr-only">{t('people.resets')}</caption>
                  <thead>
                    <tr className="border-y border-border text-xs text-muted-foreground">
                      <th scope="col" className="px-5 py-2 text-left font-medium">
                        {t('people.for')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        {t('people.requestedBy')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        {t('people.reason')}
                      </th>
                      <th scope="col" className="px-3 py-2 text-left font-medium">
                        {t('people.status')}
                      </th>
                      <th scope="col" className="px-5 py-2 text-right font-medium">
                        {t('people.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.data.resets.map((reset) => {
                      const mayDecide =
                        reset.status === 'pending' &&
                        reset.requestedBy.id !== me.id &&
                        reset.target.id !== me.id;
                      return (
                        <tr key={reset.id} className="border-b border-border last:border-0">
                          <th scope="row" className="px-5 py-2.5 text-left font-medium">
                            {reset.target.name}
                          </th>
                          <td className="px-3 py-2.5">{reset.requestedBy.name}</td>
                          <td className="px-3 py-2.5 text-muted-foreground">{reset.reason}</td>
                          <td className="px-3 py-2.5">
                            <StatusBadge
                              tone={
                                reset.status === 'pending'
                                  ? 'warning'
                                  : reset.status === 'approved'
                                    ? 'success'
                                    : 'neutral'
                              }
                            >
                              {t(`resetStatus.${reset.status}` as const)}
                            </StatusBadge>
                            {reset.decidedBy === null ? null : (
                              <span className="block text-xs text-muted-foreground">
                                {t('people.decidedBy')} {reset.decidedBy.name}
                              </span>
                            )}
                          </td>
                          <td className="px-5 py-2.5">
                            {mayDecide ? (
                              <div className="flex justify-end gap-1">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={decide.isPending}
                                  onClick={() =>
                                    decide.mutate({ id: reset.id, decision: 'reject' })
                                  }
                                >
                                  {t('people.reject')}
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={decide.isPending}
                                  onClick={() =>
                                    decide.mutate({ id: reset.id, decision: 'approve' })
                                  }
                                >
                                  {t('people.approve')}
                                </Button>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        onInvited={async (result) => {
          setInviting(false);
          setLink(result);
          await refresh();
        }}
      />
      <LinkDialog link={link} onClose={() => setLink(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing === null ? t('people.remove') : `${t('people.remove')}: ${removing.name}`}
        description={t('people.removeConfirm')}
        confirmLabel={t('people.remove')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        destructive
        onConfirm={async () => {
          if (removing === null) return;
          try {
            await endpoints.removePerson(removing.id);
            setError(null);
          } catch (cause) {
            setError(errorKey(cause));
          }
          setRemoving(null);
          await refresh();
        }}
      />
      <ResetDialog
        person={resetting}
        onClose={() => setResetting(null)}
        onDone={async (cause) => {
          setResetting(null);
          setError(cause === null ? null : errorKey(cause));
          await refresh();
        }}
      />
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  onInvited,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onInvited: (link: LinkWire) => Promise<void>;
}) {
  const { t } = useLocale();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = inviteOwnerSchema.safeParse({ email, name });
    if (!parsed.success) {
      setError('form.invalid');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onInvited(await endpoints.invite(parsed.data.email, parsed.data.name));
      setEmail('');
      setName('');
    } catch (cause) {
      setError(errorKey(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('people.invite')}
      description={t('people.inviteHint')}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        <Field
          label={t('people.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Field
          label={t('people.email')}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {error === null ? null : <Alert>{t(error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t('people.send')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function LinkDialog({
  link,
  onClose,
}: {
  readonly link: LinkWire | null;
  readonly onClose: () => void;
}) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={link !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
      title={t('people.inviteLink')}
      description={t('people.inviteHint')}
      closeLabel={t('common.close')}
      footer={
        <Button
          onClick={() => {
            if (link !== null)
              void navigator.clipboard.writeText(link.link).then(() => setCopied(true));
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      }
    >
      {link === null ? null : (
        <code className="block rounded-md bg-muted p-3 font-mono text-xs break-all text-foreground">
          {link.link}
        </code>
      )}
    </Dialog>
  );
}

function ResetDialog({
  person,
  onClose,
  onDone,
}: {
  readonly person: PersonWire | null;
  readonly onClose: () => void;
  readonly onDone: (cause: unknown) => Promise<void>;
}) {
  const { t } = useLocale();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={person !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        person === null
          ? t('people.resetTwoFactor')
          : `${t('people.resetTwoFactor')}: ${person.name}`
      }
      description={t('people.resetsHint')}
      closeLabel={t('common.close')}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (person === null || reason.trim().length < 3) return;
          setBusy(true);
          void endpoints
            .requestReset(person.id, reason.trim())
            .then(
              () => onDone(null),
              (cause: unknown) => onDone(cause),
            )
            .finally(() => {
              setBusy(false);
              setReason('');
            });
        }}
      >
        <Field
          label={t('people.reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy || reason.trim().length < 3}>
            {t('people.request')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
