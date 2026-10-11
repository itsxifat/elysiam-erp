/**
 * Addresses a customer typed into a chat (M42, D-739): the thana (and with it the district) a
 * message names, so the panel offers "Mirpur, Dhaka" with the message as the address line, saved
 * in one click.
 *
 * Matched against the brand's own geography (`ref.thanas` and `ref.districts`, English and Bangla
 * names), whole words only, case-insensitively. A thana name several districts share ("Kotwali",
 * "Sadar") counts only when the message also names one of those districts; a name too short to
 * mean anything (under three letters) never counts. Never throws.
 */

export interface AreaNames {
  readonly thanaId: number;
  readonly districtId: number;
  readonly thanaNames: readonly string[];
  readonly districtNames: readonly string[];
}

export interface AddressFound {
  readonly thanaId: number;
  readonly districtId: number;
  /** The message it was found in, on one line, as the address line to start from. */
  readonly line: string;
}

const MIN_NAME = 3;
/** A message is read up to this many characters for an address. */
const SCAN_LIMIT = 2_000;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `name` standing alone in `text`: no letter or digit, in any script, on either side. */
function wordPattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}])${escape(name)}(?![\\p{L}\\p{N}\\p{M}])`, 'iu');
}

export interface AreaMatcher {
  find(text: string): { thanaId: number; districtId: number }[];
}

/** Compile the geography once; `find` is then cheap per message. */
export function areaMatcher(areas: readonly AreaNames[]): AreaMatcher {
  const byName = new Map<string, AreaNames[]>();
  const districtPatterns = new Map<number, RegExp[]>();
  for (const area of areas) {
    for (const name of area.thanaNames) {
      const key = name.trim().toLocaleLowerCase();
      if ([...key].length < MIN_NAME) continue;
      byName.set(key, [...(byName.get(key) ?? []), area]);
    }
    if (!districtPatterns.has(area.districtId)) {
      districtPatterns.set(
        area.districtId,
        area.districtNames
          .map((name) => name.trim())
          .filter((name) => [...name].length >= MIN_NAME)
          .map(wordPattern),
      );
    }
  }
  const thanaPatterns = [...byName].map(([name, owners]) => ({
    pattern: wordPattern(name),
    owners,
  }));

  return {
    find(text: string) {
      if (typeof text !== 'string' || text === '') return [];
      const scanned = text.slice(0, SCAN_LIMIT);
      const found: { thanaId: number; districtId: number }[] = [];
      for (const { pattern, owners } of thanaPatterns) {
        if (!pattern.test(scanned)) continue;
        const named =
          owners.length === 1
            ? owners
            : owners.filter((owner) =>
                (districtPatterns.get(owner.districtId) ?? []).some((district) =>
                  district.test(scanned),
                ),
              );
        if (named.length !== 1) continue;
        const [area] = named;
        if (area !== undefined) found.push({ thanaId: area.thanaId, districtId: area.districtId });
      }
      return found;
    },
  };
}

/** Addresses across messages, newest message first, each thana once, at most `limit`. */
export function addressesInTexts(
  texts: readonly (string | null)[],
  matcher: AreaMatcher,
  limit = 3,
): AddressFound[] {
  const out: AddressFound[] = [];
  const seen = new Set<number>();
  for (const text of texts) {
    if (text === null) continue;
    for (const area of matcher.find(text)) {
      if (seen.has(area.thanaId)) continue;
      seen.add(area.thanaId);
      out.push({ ...area, line: text.replace(/\s+/g, ' ').trim().slice(0, 500) });
      if (out.length >= limit) return out;
    }
  }
  return out;
}
