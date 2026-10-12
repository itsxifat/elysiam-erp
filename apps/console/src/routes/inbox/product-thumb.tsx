import { cn } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { ImageOff } from 'lucide-react';

import { imageUrl } from '../catalog/api.js';

/**
 * A product photo through a short-lived signed address, as the catalog's own screens show it
 * (M42's interests, M44b's picker). The address is cached for four minutes.
 */
export function ProductThumb({
  fileId,
  alt,
  size = 'md',
}: {
  readonly fileId: string | null;
  readonly alt: string;
  readonly size?: 'sm' | 'md';
}) {
  const url = useQuery({
    queryKey: ['files', 'url', fileId],
    queryFn: () => imageUrl(fileId ?? ''),
    enabled: fileId !== null,
    staleTime: 4 * 60_000,
  });
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted',
        size === 'sm' ? 'size-10' : 'size-14',
      )}
    >
      {url.data === undefined ? (
        <ImageOff aria-hidden className="size-4 text-muted-foreground" />
      ) : (
        <img src={url.data.url} alt={alt} className="size-full object-cover" />
      )}
    </div>
  );
}
