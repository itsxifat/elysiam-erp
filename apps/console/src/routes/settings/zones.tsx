import {
  Button,
  Dialog,
  Money,
  poishaToTaka,
  Select,
  StatusBadge,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useId, useState } from 'react';

import { useLocale } from '../../i18n/locale.js';
import { listZones, saveZone, type CourierParty, type ZoneRow } from './api.js';
import { useSettingsT } from './messages.js';
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
 * Delivery zones and their charges (§9; D-009 is OPEN, so the seeded charges are placeholders
 * an org replaces here; D-394).
 *
 * A zone is saved by its code (`PUT /v1/delivery-zones` upserts), so editing one keeps its
 * code and a new code makes a new zone. Which thanas a zone covers is the seed's district-wide
 * mapping and is not edited here (a follow-up).
 */
export function ZonesPage() {
  const t = useSettingsT();
  const { locale } = useLocale();
  const query = useQuery({ queryKey: ['settings', 'zones'], queryFn: listZones });
  const [editing, setEditing] = useState<ZoneRow | 'new' | null>(null);

  return (
    <SettingsPage tab="/settings/zones">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">{t('settings.zones.caption')}</p>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus aria-hidden="true" />
          {t('settings.zones.add')}
        </Button>
      </div>
      <Loadable query={query}>
        {(data) =>
          data.zones.length === 0 ? (
            <Empty />
          ) : (
            <>
              <table className={tableClass}>
                <caption className="sr-only">{t('settings.nav.zones')}</caption>
                <thead>
                  <tr className={headClass}>
                    <th className="py-1.5 font-medium">{t('settings.zones.colCode')}</th>
                    <th className="py-1.5 font-medium">{t('settings.zones.colNameEn')}</th>
                    <th className="py-1.5 text-right font-medium">
                      {t('settings.zones.colCharge')}
                    </th>
                    <th className="py-1.5 pl-4 font-medium">{t('settings.zones.colCourier')}</th>
                    <th className="py-1.5 font-medium">{t('settings.colStatus')}</th>
                    <th className="py-1.5">
                      <span className="sr-only">{t('settings.edit')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.zones.map((zone) => (
                    <tr key={zone.id} className={rowClass}>
                      <td className="py-1.5 font-mono text-xs">{zone.code}</td>
                      <td className="py-1.5">{zone.nameEn}</td>
                      <td className="py-1.5 text-right">
                        <Money poisha={zone.chargePoisha} locale={locale} />
                      </td>
                      <td className="py-1.5 pl-4">
                        {data.couriers.find((courier) => courier.id === zone.defaultCourierId)
                          ?.name ?? t('settings.zones.noCourier')}
                      </td>
                      <td className="py-1.5">
                        <StatusBadge tone={zone.isActive ? 'success' : 'neutral'}>
                          {zone.isActive ? t('settings.active') : t('settings.inactive')}
                        </StatusBadge>
                      </td>
                      <td className="py-1.5 text-right">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(zone)}>
                          {t('settings.edit')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {editing === null ? null : (
                <ZoneDialog
                  zone={editing === 'new' ? null : editing}
                  couriers={data.couriers}
                  onClose={() => setEditing(null)}
                />
              )}
            </>
          )
        }
      </Loadable>
    </SettingsPage>
  );
}

function ZoneDialog({
  zone,
  couriers,
  onClose,
}: {
  readonly zone: ZoneRow | null;
  readonly couriers: readonly CourierParty[];
  readonly onClose: () => void;
}) {
  const t = useSettingsT();
  const id = useId();
  const queryClient = useQueryClient();
  const [code, setCode] = useState(zone?.code ?? '');
  const [nameEn, setNameEn] = useState(zone?.nameEn ?? '');
  const [charge, setCharge] = useState(zone === null ? '' : poishaToTaka(zone.chargePoisha));
  const [courierId, setCourierId] = useState(zone?.defaultCourierId ?? '');
  const [active, setActive] = useState(zone?.isActive ?? true);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (chargePoisha: string) =>
      saveZone({
        code: code.trim(),
        nameEn: nameEn.trim(),
        chargePoisha,
        ...(courierId === '' ? {} : { defaultCourierId: courierId }),
        ...(zone === null ? {} : { position: zone.position }),
        isActive: active,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings', 'zones'] });
      await queryClient.invalidateQueries({ queryKey: ['orders', 'areas'] });
      onClose();
    },
    onError: (error) => setProblem(messageOf(error, t('settings.errorDetail'))),
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('settings.zones.formTitle')}
      closeLabel={t('settings.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('settings.cancel')}
          </Button>
          <Button
            disabled={save.isPending}
            onClick={() => {
              const poisha = takaToPoisha(charge);
              if (
                !/^[a-z][a-z0-9_]{1,31}$/.test(code.trim()) ||
                nameEn.trim() === '' ||
                poisha === null ||
                poisha.startsWith('-')
              ) {
                setProblem(t('settings.zones.invalid'));
                return;
              }
              setProblem(null);
              save.mutate(poisha);
            }}
          >
            {t('settings.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id={`${id}-code`}
          label={t('settings.zones.colCode')}
          hint={t('settings.zones.codeHint')}
        >
          <input
            id={`${id}-code`}
            value={code}
            readOnly={zone !== null}
            maxLength={32}
            autoComplete="off"
            className={`${control} font-mono`}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>
        <Field id={`${id}-charge`} label={t('settings.zones.chargeInput')}>
          <input
            id={`${id}-charge`}
            inputMode="decimal"
            value={charge}
            className={`${control} tabular-nums`}
            onChange={(event) => setCharge(event.target.value)}
          />
        </Field>
        <Field id={`${id}-en`} label={t('settings.zones.colNameEn')}>
          <input
            id={`${id}-en`}
            value={nameEn}
            maxLength={120}
            className={control}
            onChange={(event) => setNameEn(event.target.value)}
          />
        </Field>
        <Field id={`${id}-courier`} label={t('settings.zones.colCourier')}>
          <Select
            id={`${id}-courier`}
            value={courierId}
            onValueChange={setCourierId}
            options={[
              { value: '', label: t('settings.zones.noCourier') },
              ...couriers.map((courier) => ({ value: courier.id, label: courier.name })),
            ]}
          />
        </Field>
        <label className="flex items-center gap-2 self-end text-sm" htmlFor={`${id}-active`}>
          <input
            id={`${id}-active`}
            type="checkbox"
            checked={active}
            className="size-4 accent-primary"
            onChange={(event) => setActive(event.target.checked)}
          />
          {t('settings.active')}
        </label>
      </div>
      {problem === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {problem}
        </p>
      )}
    </Dialog>
  );
}
