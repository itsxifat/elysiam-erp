import { encode } from 'uqr';
import { useMemo } from 'react';

/**
 * The authenticator app's QR code (M40, D-699), drawn here from the `otpauth://` address.
 *
 * Drawn in the browser rather than fetched from a QR service: the address carries the secret,
 * and it must not leave this page. One SVG path, dark modules on the scan surface tokens (dark
 * on light in both themes, which every phone camera reads). Its own module so the encoder ships
 * only with the screens that show a code, never in the first download.
 */
export function TotpQr({ uri, label }: { readonly uri: string; readonly label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(uri, { ecc: 'M', border: 2 });
    let d = '';
    for (let y = 0; y < qr.size; y += 1) {
      const row = qr.data[y] ?? [];
      for (let x = 0; x < qr.size; x += 1) {
        if (row[x] === true) d += `M${String(x)} ${String(y)}h1v1h-1z`;
      }
    }
    return { size: qr.size, path: d };
  }, [uri]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      className="size-44 rounded-md border border-border bg-scan-surface fill-scan-ink"
    >
      <path d={path} />
    </svg>
  );
}

export default TotpQr;
