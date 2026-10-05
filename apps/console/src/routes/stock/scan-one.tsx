import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import { lookupCode } from '../catalog/api.js';
import { ScanField } from '../catalog/scan-field.js';

/**
 * A scan field over a one-item stock form (M38a, D-605): the transfer and adjustment sheets
 * send one SKU at a time. Scanning a sticker chooses its SKU; scanning the same one again
 * adds a piece. Only SKUs the chosen location holds can be chosen, as in the form's own list.
 */
export function ScanOneSku({
  held,
  skuId,
  onChoose,
  onOneMore,
}: {
  /** The SKUs at the chosen location. */
  readonly held: readonly { readonly skuId: string }[];
  readonly skuId: string;
  readonly onChoose: (skuId: string) => void;
  readonly onOneMore: () => void;
}) {
  const t = useT();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const scan = async (code: string) => {
    try {
      const found = await lookupCode(code);
      const label =
        found.sku.variantLabel === ''
          ? found.product.name
          : `${found.product.name} · ${found.sku.variantLabel}`;
      if (!held.some((row) => row.skuId === found.sku.id)) {
        setMessage({ text: `${t('st.scan.notHere')} ${label}`, error: true });
        return;
      }
      if (found.sku.id === skuId) onOneMore();
      else onChoose(found.sku.id);
      setMessage({ text: `${t('st.scan.added')} ${label}`, error: false });
    } catch (error) {
      setMessage({
        text:
          error instanceof ApiError && error.status === 404
            ? t('st.scan.notFound')
            : t('st.scan.failed'),
        error: true,
      });
    }
  };

  return (
    <ScanField
      autoFocus={false}
      message={message?.text ?? null}
      tone={message?.error === true ? 'error' : 'neutral'}
      onCode={(code) => void scan(code)}
    />
  );
}
