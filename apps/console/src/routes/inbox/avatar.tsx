import { cn, initials } from '@elysium/ui';
import { useState } from 'react';

/**
 * A contact's face (M44a, D-761): Meta's photo when there is one, else their initials on one of
 * the kit's quiet tints, picked by the contact's id so a person keeps their colour. The photo's
 * URL expires within days; one that no longer loads shows the initials underneath.
 */

const TINTS = [
  'bg-selected text-selected-foreground',
  'bg-info-subtle text-info-subtle-foreground',
  'bg-success-subtle text-success-subtle-foreground',
  'bg-warning-subtle text-warning-subtle-foreground',
  'bg-muted text-muted-foreground',
] as const;

/** The tint for an id: the same id, the same tint. Pure, for the test. */
export function tintIndex(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return hash % TINTS.length;
}

const SIZES = {
  sm: 'size-7 text-2xs',
  md: 'size-9 text-xs',
  lg: 'size-10 text-sm',
  // M49: the customer panel's header.
  xl: 'size-14 text-base',
} as const;

export function ContactAvatar({
  id,
  name,
  url,
  size = 'md',
  className,
}: {
  readonly id: string;
  readonly name: string | null;
  readonly url: string | null;
  readonly size?: keyof typeof SIZES;
  readonly className?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const photo = url !== null && broken !== url ? url : null;
  const letters = initials(name ?? '') || '?';
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold select-none',
        SIZES[size],
        TINTS[tintIndex(id)],
        className,
      )}
    >
      {letters}
      {photo === null ? null : (
        <img
          src={photo}
          alt=""
          loading="lazy"
          decoding="async"
          // Meta's CDN needs no referrer, and the console's address is nobody else's business.
          referrerPolicy="no-referrer"
          onError={() => setBroken(photo)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}
