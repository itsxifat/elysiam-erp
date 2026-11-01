import { Button, Checkbox, DateTime, Dialog, Input, Skeleton, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import { VIDEO_TONE, formatElapsed } from './pack-logic.js';
import { recentPacking, savePackingSettings, type PackingSettings } from './pack-station-api.js';
import { ordersPath } from './paths.js';

/**
 * The station's recent sessions and the brand's packing settings (M38b, D-615, D-617), with
 * the packing tables' IP cameras (M38c, D-668).
 */

/** "Recent packing": who packed what, how long it took, what was caught, and the video. */
export function RecentPacking() {
  const t = useT();
  const id = useId();
  const recent = useQuery({ queryKey: ['packing', 'recent'], queryFn: recentPacking });
  const items = recent.data?.items ?? [];
  return (
    <section
      aria-labelledby={id}
      className="rounded-lg border border-border bg-card text-card-foreground"
    >
      <div className="space-y-0.5 px-5 pt-4 pb-3">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {t('ps.recent.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('ps.recent.description')}</p>
      </div>
      <div className="px-5 pb-5">
        {recent.isPending ? (
          <Skeleton className="h-24" />
        ) : recent.isError ? (
          <p role="alert" className="text-sm text-destructive-text">
            {recent.error instanceof ApiError ? recent.error.message : t('ps.failed')}
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('ps.recent.none')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3"
              data-testid="pack-recent"
            >
              <caption className="sr-only">{t('ps.recent.title')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="font-medium">{t('ps.recent.order')}</th>
                  <th className="font-medium">{t('ps.recent.packer')}</th>
                  <th className="font-medium">{t('ps.recent.started')}</th>
                  <th className="text-right font-medium">{t('ps.recent.duration')}</th>
                  <th className="text-right font-medium">{t('ps.recent.pieces')}</th>
                  <th className="text-right font-medium">{t('ps.recent.mismatches')}</th>
                  <th className="font-medium">{t('ps.recent.video')}</th>
                  <th className="font-medium">{t('ps.recent.status')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="h-row border-b border-border last:border-b-0">
                    <td>
                      <Link
                        to={ordersPath(`/orders/${item.orderId}`)}
                        className="font-medium tabular-nums underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {item.orderNo}
                      </Link>
                    </td>
                    <td>{(item.completedBy ?? item.startedBy).name ?? '—'}</td>
                    <td>
                      <DateTime value={item.startedAt} />
                    </td>
                    <td className="text-right tabular-nums">
                      {item.durationMs === null ? '—' : formatElapsed(item.durationMs)}
                    </td>
                    <td className="text-right tabular-nums">{item.pieces}</td>
                    <td className="text-right tabular-nums">
                      {item.mismatches === 0 ? (
                        '0'
                      ) : (
                        <StatusBadge tone="danger">{String(item.mismatches)}</StatusBadge>
                      )}
                    </td>
                    <td>
                      <StatusBadge tone={VIDEO_TONE[item.video]}>
                        {t(`ps.video.state.${item.video}`)}
                      </StatusBadge>
                    </td>
                    <td>
                      <StatusBadge tone={item.status === 'completed' ? 'success' : 'info'}>
                        {t(`ps.session.${item.status}`)}
                      </StatusBadge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/** Recording on or off for the brand: org admins only (D-615). */
export function PackSettingsDialog({
  settings,
  onClose,
}: {
  readonly settings: PackingSettings;
  readonly onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [videoEnabled, setVideoEnabled] = useState(settings.videoEnabled);
  // M51 (D-931): the pause after so many seconds with no scan, 3 to 60.
  const [idle, setIdle] = useState(String(settings.idlePauseSeconds ?? 10));
  const idleSeconds = Number(idle);
  const idleValid = Number.isInteger(idleSeconds) && idleSeconds >= 3 && idleSeconds <= 60;
  // M52 (D-941): above how many pieces Confirm asks how many lots; empty asks nobody.
  const [lotAsk, setLotAsk] = useState(
    settings.lotAskAbovePieces === null || settings.lotAskAbovePieces === undefined
      ? ''
      : String(settings.lotAskAbovePieces),
  );
  const lotAskValue = lotAsk.trim() === '' ? null : Number(lotAsk);
  const lotAskValid =
    lotAskValue === null ||
    (Number.isInteger(lotAskValue) && lotAskValue >= 1 && lotAskValue <= 500);
  const save = useMutation({
    mutationFn: () => savePackingSettings(videoEnabled, idleSeconds, lotAskValue),
    onSuccess: (next) => {
      queryClient.setQueryData(['packing', 'settings'], next);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('ps.settings.title')}
      description={t('ps.settings.videoHelp')}
      closeLabel={t('ps.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('ps.cancel')}
          </Button>
          <Button
            disabled={save.isPending || !idleValid || !lotAskValid}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('ps.saving') : t('ps.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${id}-video`}
            checked={videoEnabled}
            onCheckedChange={(next) => setVideoEnabled(next === true)}
          />
          <label htmlFor={`${id}-video`} className="font-medium">
            {t('ps.settings.video')}
          </label>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-idle`} className="font-medium">
            {t('ps.settings.idle')}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-idle`}
              type="number"
              inputMode="numeric"
              min={3}
              max={60}
              value={idle}
              onChange={(event) => setIdle(event.target.value)}
              aria-invalid={!idleValid}
              aria-describedby={`${id}-idle-help`}
              className="w-24 tabular-nums"
            />
            <span className="text-muted-foreground">{t('ps.settings.seconds')}</span>
          </div>
          <p id={`${id}-idle-help`} className="text-xs text-muted-foreground">
            {t('ps.settings.idleHelp')}
          </p>
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${id}-lot-ask`} className="font-medium">
            {t('ps.settings.lotAsk')}
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={`${id}-lot-ask`}
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              value={lotAsk}
              onChange={(event) => setLotAsk(event.target.value)}
              aria-invalid={!lotAskValid}
              aria-describedby={`${id}-lot-ask-help`}
              className="w-24 tabular-nums"
              data-testid="lot-ask-above"
            />
            <span className="text-muted-foreground">{t('ps.settings.lotAskUnit')}</span>
          </div>
          <p id={`${id}-lot-ask-help`} className="text-xs text-muted-foreground">
            {t('ps.settings.lotAskHelp')}
          </p>
        </div>
        {save.error === null ? null : (
          <p role="alert" className="text-destructive-text">
            {save.error instanceof ApiError ? save.error.message : t('ps.failed')}
          </p>
        )}
      </div>
    </Dialog>
  );
}
