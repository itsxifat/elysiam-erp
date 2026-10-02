import { Button, Dialog, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useId, useState } from 'react';

import { listWallets } from '../accounts/api.js';
import { listBranches } from '../branches/api.js';
import {
  createRegister,
  listLocations,
  listRegisters,
  setRegisterActive,
  type RegisterRow,
} from './api.js';
import { walletsFor } from './logic.js';
import { useSettingsT, type SettingsMessageKey } from './messages.js';
import {
  control,
  Empty,
  Field,
  headClass,
  Loadable,
  messageOf,
  rowClass,
  SettingsPage,
  tableClass,
} from './parts.js';

/**
 * Till registers (M23's POS; D-394).
 *
 * A register ties a till to a branch, the shelf it sells from and the wallet each tender lands
 * in. The pickers offer what the server will accept (`RegistersService.assertWallets`): cash is
 * the branch's own hand-cash wallet; bKash a mobile wallet and card a bank wallet, of the
 * branch or the brand. Both are checked again on the server. A register is never deleted —
 * its shifts and sales name it — so it is deactivated instead.
 */

export function RegistersPage() {
  const t = useSettingsT();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['settings', 'registers'], queryFn: listRegisters });
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const toggle = useMutation({
    mutationFn: (register: RegisterRow) => setRegisterActive(register.id, !register.isActive),
    onSuccess: async () => {
      setProblem(null);
      await queryClient.invalidateQueries({ queryKey: ['settings', 'registers'] });
    },
    onError: (error) => setProblem(messageOf(error, t('settings.errorDetail'))),
  });

  return (
    <SettingsPage tab="/settings/registers">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{t('settings.registers.caption')}</p>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus aria-hidden="true" />
          {t('settings.registers.add')}
        </Button>
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <Loadable query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty />
          ) : (
            <table className={tableClass}>
              <caption className="sr-only">{t('settings.nav.registers')}</caption>
              <thead>
                <tr className={headClass}>
                  <th className="py-1.5 font-medium">{t('settings.registers.colBranch')}</th>
                  <th className="py-1.5 font-medium">{t('settings.registers.colCode')}</th>
                  <th className="py-1.5 font-medium">{t('settings.registers.colName')}</th>
                  <th className="py-1.5 font-medium">{t('settings.registers.colLocation')}</th>
                  <th className="py-1.5 font-medium">{t('settings.registers.colTenders')}</th>
                  <th className="py-1.5 font-medium">{t('settings.colStatus')}</th>
                  <th className="py-1.5">
                    <span className="sr-only">{t('settings.edit')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((register) => (
                  <tr key={register.id} className={rowClass}>
                    <td className="py-1.5">{register.branchName}</td>
                    <td className="py-1.5 font-mono text-xs">{register.code}</td>
                    <td className="py-1.5">{register.name}</td>
                    <td className="py-1.5">{register.locationName}</td>
                    <td className="py-1.5">
                      {register.tenders
                        .map((tender) =>
                          t(`settings.registers.tender.${tender}` as SettingsMessageKey),
                        )
                        .join(' · ')}
                    </td>
                    <td className="py-1.5">
                      <StatusBadge tone={register.isActive ? 'success' : 'neutral'}>
                        {register.isActive ? t('settings.active') : t('settings.inactive')}
                      </StatusBadge>
                    </td>
                    <td className="py-1.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate(register)}
                      >
                        {register.isActive
                          ? t('settings.registers.deactivate')
                          : t('settings.registers.activate')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Loadable>
      {adding ? <RegisterDialog onClose={() => setAdding(false)} /> : null}
    </SettingsPage>
  );
}

function RegisterDialog({ onClose }: { readonly onClose: () => void }) {
  const t = useSettingsT();
  const id = useId();
  const queryClient = useQueryClient();
  const branches = useQuery({ queryKey: ['settings', 'branches'], queryFn: listBranches });
  const locations = useQuery({ queryKey: ['settings', 'locations'], queryFn: listLocations });
  const wallets = useQuery({ queryKey: ['settings', 'wallets'], queryFn: () => listWallets() });

  const [branchId, setBranchId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [cash, setCash] = useState('');
  const [bkash, setBkash] = useState('');
  const [card, setCard] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const allWallets = wallets.data?.items ?? [];
  const branchLocations = (locations.data?.items ?? []).filter(
    (location) => location.isActive && location.branchId === branchId,
  );

  const save = useMutation({
    mutationFn: () =>
      createRegister({
        branchId,
        locationId,
        code: code.trim().toUpperCase(),
        name: name.trim(),
        cashWalletId: cash,
        ...(bkash === '' ? {} : { bkashWalletId: bkash }),
        ...(card === '' ? {} : { cardWalletId: card }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings', 'registers'] });
      onClose();
    },
    onError: (error) => setProblem(messageOf(error, t('settings.errorDetail'))),
  });

  const picker = (
    key: string,
    label: string,
    value: string,
    set: (next: string) => void,
    options: readonly { id: string; name: string }[],
  ) => (
    <Field id={`${id}-${key}`} label={label}>
      <select
        id={`${id}-${key}`}
        value={value}
        className={control}
        onChange={(event) => set(event.target.value)}
      >
        <option value="">{t('settings.choose')}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('settings.registers.formTitle')}
      closeLabel={t('settings.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('settings.cancel')}
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              if (
                branchId === '' ||
                locationId === '' ||
                cash === '' ||
                !/^[A-Z0-9]{2,8}$/.test(code.trim().toUpperCase()) ||
                name.trim() === ''
              ) {
                setProblem(t('settings.registers.invalid'));
                return;
              }
              setProblem(null);
              save.mutate();
            }}
          >
            {t('settings.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {picker(
          'branch',
          t('settings.registers.colBranch'),
          branchId,
          (next) => {
            setBranchId(next);
            setLocationId('');
            setCash('');
            setBkash('');
            setCard('');
          },
          (branches.data?.items ?? []).map((branch) => ({ id: branch.id, name: branch.name })),
        )}
        {picker(
          'location',
          t('settings.registers.colLocation'),
          locationId,
          setLocationId,
          branchLocations,
        )}
        <Field
          id={`${id}-code`}
          label={t('settings.registers.colCode')}
          hint={t('settings.registers.codeHint')}
        >
          <input
            id={`${id}-code`}
            value={code}
            maxLength={8}
            autoComplete="off"
            className={`${control} font-mono uppercase`}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
        <Field id={`${id}-name`} label={t('settings.registers.colName')}>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            className={control}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        {picker(
          'cash',
          t('settings.registers.fieldCash'),
          cash,
          setCash,
          walletsFor(allWallets, branchId, 'cash'),
        )}
        {picker(
          'bkash',
          t('settings.registers.fieldBkash'),
          bkash,
          setBkash,
          walletsFor(allWallets, branchId, 'bkash'),
        )}
        {picker(
          'card',
          t('settings.registers.fieldCard'),
          card,
          setCard,
          walletsFor(allWallets, branchId, 'card'),
        )}
      </div>
      {problem === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
