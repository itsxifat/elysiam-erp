import { Button, Dialog } from '@elysium/ui';
import { Camera } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';

/**
 * "Scan with camera" (M38a, D-605): on a phone with no scanner attached, the browser's own
 * barcode reader (`BarcodeDetector`, EAN-13 and Code 128) reads a sticker through the
 * camera. Shown only where the browser has one; elsewhere a person types the code, which
 * the scan field takes just the same.
 *
 * The video stays on the device: frames are read in the page and nothing is uploaded.
 */

interface DetectedBarcode {
  readonly rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<readonly DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new (options: {
  readonly formats: readonly string[];
}) => BarcodeDetectorLike;

function detectorClass(): BarcodeDetectorConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
}

/** Whether this browser can read barcodes through the camera. */
export function cameraScanSupported(): boolean {
  return detectorClass() !== undefined && navigator.mediaDevices?.getUserMedia !== undefined;
}

export function CameraScanButton({
  onCode,
  size = 'sm',
}: {
  readonly onCode: (code: string) => void;
  readonly size?: 'sm' | 'icon-sm';
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!cameraScanSupported()) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={size}
        aria-label={t('st.scan.camera')}
        onClick={() => setOpen(true)}
      >
        <Camera aria-hidden="true" />
        {size === 'sm' ? t('st.scan.camera') : null}
      </Button>
      {open ? (
        <CameraDialog
          onClose={() => setOpen(false)}
          onCode={(code) => {
            setOpen(false);
            onCode(code);
          }}
        />
      ) : null}
    </>
  );
}

function CameraDialog({
  onClose,
  onCode,
}: {
  readonly onClose: () => void;
  readonly onCode: (code: string) => void;
}) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  // The latest callback, so a re-render of the page behind does not restart the camera.
  const deliver = useRef(onCode);
  useEffect(() => {
    deliver.current = onCode;
  });

  useEffect(() => {
    const Detector = detectorClass();
    if (Detector === undefined) return undefined;
    const detector = new Detector({ formats: ['ean_13', 'code_128'] });
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        const element = video.current;
        if (element === null || stopped) return;
        element.srcObject = stream;
        await element.play();
        const read = async () => {
          if (stopped || element.readyState < 2) {
            timer = window.setTimeout(() => void read(), 200);
            return;
          }
          const found = await detector.detect(element).catch(() => []);
          const code = found[0]?.rawValue.trim();
          if (code !== undefined && code !== '') {
            deliver.current(code);
            return;
          }
          timer = window.setTimeout(() => void read(), 200);
        };
        void read();
      } catch {
        setFailed(true);
      }
    }
    void start();

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
  }, []);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('st.scan.cameraTitle')}
      description={t('st.scan.cameraHelp')}
      closeLabel={t('st.close')}
    >
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('st.scan.cameraFailed')}
        </p>
      ) : (
        <video
          ref={video}
          muted
          playsInline
          aria-label={t('st.scan.cameraTitle')}
          className="aspect-[4/3] w-full rounded-lg border border-border bg-muted object-cover"
        />
      )}
    </Dialog>
  );
}
