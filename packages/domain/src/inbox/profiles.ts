/**
 * A sender's name and photo from Meta (M44a, D-761; invariant 11): when to ask Meta again, and
 * what the contact's name becomes when Meta answers.
 */

/** A photo URL from Meta expires within days (both User Profile APIs say so): ask again after this. */
export const PROFILE_REFRESH_MS = 3 * 24 * 60 * 60 * 1000;

/** Whether the profile should be asked for now. Never asked: yes. */
export function profileRefreshDue(fetchedAt: Date | null, now: Date): boolean {
  if (fetchedAt === null) return true;
  return now.getTime() - fetchedAt.getTime() >= PROFILE_REFRESH_MS;
}

/** What Meta said about a person, read leniently: every field may be missing or blank. */
export interface MetaProfile {
  readonly name?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly username?: string | null;
  readonly pictureUrl?: string | null;
}

const clean = (value: string | null | undefined, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? null : text.slice(0, max);
};

/** The person's name: Instagram's `name`, else Messenger's first and last, else the username. */
export function profileDisplayName(profile: MetaProfile): string | null {
  const full = clean(profile.name, 200);
  if (full !== null) return full;
  const parts = [clean(profile.firstName, 100), clean(profile.lastName, 100)].filter(
    (part): part is string => part !== null,
  );
  if (parts.length > 0) return parts.join(' ').slice(0, 200);
  return clean(profile.username, 64);
}

/** Only an `https` URL is kept for a photo; anything else is no photo. */
export function profilePictureUrl(value: string | null | undefined): string | null {
  const text = clean(value, 2048);
  if (text === null) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}

/** Instagram usernames: letters, digits, dots and underscores. */
export function profileHandle(value: string | null | undefined): string | null {
  const text = clean(value, 64);
  return text !== null && /^[A-Za-z0-9._]{1,64}$/.test(text) ? text : null;
}

/**
 * The contact's name after Meta answers. A name nobody set (null), or the one Meta gave last
 * time, follows Meta; a name a person typed in is theirs and stays.
 */
export function nextContactName(
  current: string | null,
  previousFromMeta: string | null,
  fromMeta: string | null,
): string | null {
  if (fromMeta === null) return current;
  if (current === null || current === previousFromMeta) return fromMeta;
  return current;
}
