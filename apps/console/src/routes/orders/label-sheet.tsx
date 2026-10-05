import { ORDER_LABEL_SIZES, type OrderLabelSize } from '@elysium/contracts';
import type { MessageKey } from '@elysium/i18n';
import { Button, Checkbox, Dialog, Select } from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

import { ApiError } from '../../api.js';
import { useSession } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/packing.js';
import { orderLabelsPdf } from './packing-api.js';

/**
 * The label sheet (M35b, D-555): the old site's order labels, for the orders ticked on the
 * list. The person picks the paper (A4 to a 4×6 thermal label or an 80 mm roll), which way it
 * is turned, and what is printed: the shop's name, the order's QR code, the prices and the
 * amount to collect. Their choice is remembered on this device. The PDF opens in a new tab,
 * where the browser's print dialog is one click away.
 */

interface LabelPrefs {
  readonly size: OrderLabelSize;
  readonly layout: 'portrait' | 'landscape';
  readonly showShopName: boolean;
  readonly showQr: boolean;
  readonly showPrices: boolean;
  readonly showCod: boolean;
}

const DEFAULT_PREFS: LabelPrefs = {
  size: '4x6',
  layout: 'portrait',
  showShopName: true,
  showQr: true,
  showPrices: true,
  showCod: true,
};

const prefsKey = (userId: string) => `erp.label-sheet.${userId}`;

function readPrefs(userId: string): LabelPrefs {
  try {
    const raw = window.localStorage.getItem(prefsKey(userId));
    if (raw === null) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Record<keyof LabelPrefs, unknown>>;
    const size = ORDER_LABEL_SIZES.find((value) => value === parsed.size);
    return {
      size: size ?? DEFAULT_PREFS.size,
      layout: parsed.layout === 'landscape' ? 'landscape' : 'portrait',
      showShopName: parsed.showShopName !== false,
      showQr: parsed.showQr !== false,
      showPrices: parsed.showPrices !== false,
      showCod: parsed.showCod !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function writePrefs(userId: string, prefs: LabelPrefs): void {
  try {
    window.localStorage.setItem(prefsKey(userId), JSON.stringify(prefs));
  } catch {
    // Storage refused (a private window): the choice is simply not remembered.
  }
}

const SIZE_KEYS: Readonly<Record<OrderLabelSize, MessageKey>> = {
  a4: 'pk.labels.size.a4',
  a5: 'pk.labels.size.a5',
  a6: 'pk.labels.size.a6',
  '2x3': 'pk.labels.size.2x3',
  '3x2': 'pk.labels.size.3x2',
  '4x6': 'pk.labels.size.4x6',
  '100x150': 'pk.labels.size.100x150',
  '80mm': 'pk.labels.size.80mm',
};

export function LabelSheetDialog({
  orderIds,
  open,
  onOpenChange,
}: {
  readonly orderIds: readonly string[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const id = useId();
  const userId = useSession().context?.userId ?? '';
  const [prefs, setPrefs] = useState<LabelPrefs>(() => readPrefs(userId));
  const [ready, setReady] = useState<string | null>(null);
  const made = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const url of made.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const change = (patch: Partial<LabelPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    writePrefs(userId, next);
  };

  const print = useMutation({
    mutationFn: async () => {
      const blob = await orderLabelsPdf({ orderIds, ...prefs });
      const url = URL.createObjectURL(blob);
      made.current.push(url);
      return url;
    },
    onMutate: () => setReady(null),
    onSuccess: (url) => {
      setReady(url);
      window.open(url, '_blank', 'noopener');
    },
  });

  const flag = (key: 'showShopName' | 'showQr' | 'showPrices' | 'showCod', label: MessageKey) => (
    <label key={key} className="flex items-center gap-2 text-sm">
      <Checkbox checked={prefs[key]} onCheckedChange={(next) => change({ [key]: next === true })} />
      {t(label)}
    </label>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('pk.labels.title')}
      description={`${String(orderIds.length)} ${t('pk.labels.orders')}`}
      closeLabel={t('pk.close')}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('pk.close')}
          </Button>
          <Button
            data-testid="label-sheet-print"
            disabled={orderIds.length === 0 || print.isPending}
            onClick={() => print.mutate()}
          >
            <Printer aria-hidden="true" />
            {t('pk.labels.print')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-size`} className="text-sm font-medium">
              {t('pk.labels.size')}
            </label>
            <Select
              id={`${id}-size`}
              value={prefs.size}
              onValueChange={(value) => change({ size: value as OrderLabelSize })}
              options={ORDER_LABEL_SIZES.map((value) => ({ value, label: t(SIZE_KEYS[value]) }))}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor={`${id}-layout`} className="text-sm font-medium">
              {t('pk.labels.layout')}
            </label>
            <Select
              id={`${id}-layout`}
              value={prefs.layout}
              onValueChange={(value) =>
                change({ layout: value === 'landscape' ? 'landscape' : 'portrait' })
              }
              options={[
                { value: 'portrait', label: t('pk.labels.portrait') },
                { value: 'landscape', label: t('pk.labels.landscape') },
              ]}
            />
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {flag('showShopName', 'pk.labels.shopName')}
          {flag('showQr', 'pk.labels.qr')}
          {flag('showPrices', 'pk.labels.prices')}
          {flag('showCod', 'pk.labels.cod')}
        </div>
        {print.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {print.error instanceof ApiError ? print.error.message : t('pk.labels.failed')}
          </p>
        )}
        {ready === null ? null : (
          <p className="text-sm">
            <a
              href={ready}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('pk.labels.open')}
            </a>
          </p>
        )}
      </div>
    </Dialog>
  );
}
