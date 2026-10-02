import type { NarrativePayload, NarrativePrompt } from '@elysium/domain/analytics';

/**
 * The LLM narrative's provider port (architecture §18; M24, D-327).
 *
 * A provider receives a `NarrativePrompt` — fixed instructions and the payload as JSON,
 * already checked by `assertNarrativePayloadSafe` — and returns plain text. It is called
 * outside any database transaction (invariant 6).
 *
 * Only the fake exists. A real adapter is deliberately not built in M24 (D-327): the
 * feature is off by default, no brand has asked for it, and an adapter nobody can run
 * against a real account would be one more unverified integration to carry. Adding one is
 * a class beside this and a value in `ANALYTICS_NARRATIVE_PROVIDER`.
 */
export interface NarrativeProvider {
  /** Stored with each narrative, so a cached text says what wrote it. */
  readonly name: string;
  generate(prompt: NarrativePrompt, payload: NarrativePayload): Promise<string>;
}

export const NARRATIVE_PROVIDER = Symbol('NarrativeProvider');

const taka = (poisha: string | null): string =>
  poisha === null ? 'n/a' : `Tk ${(BigInt(poisha) / 100n).toString()}`;

/** Basis points as a percentage with two decimals, in integers (invariant 1's spirit). */
const percent = (bps: string | null): string => {
  if (bps === null) return 'n/a';
  const value = BigInt(bps);
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  return `${sign}${(magnitude / 100n).toString()}.${(magnitude % 100n).toString().padStart(2, '0')}%`;
};

/** ROAS basis points as a multiple with two decimals: 25,000 → 2.50x. */
const multiple = (bps: string | null): string => {
  if (bps === null) return 'n/a';
  const hundredths = BigInt(bps) / 100n;
  return `${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, '0')}x`;
};

/**
 * A deterministic stand-in that writes its summary from the payload alone. It also keeps
 * every prompt it was given, so a test can read exactly what would have left the building.
 */
export class FakeNarrativeProvider implements NarrativeProvider {
  readonly name = 'fake';
  readonly prompts: NarrativePrompt[] = [];

  generate(prompt: NarrativePrompt, payload: NarrativePayload): Promise<string> {
    this.prompts.push(prompt);
    const now = payload.current;
    const before = payload.previous;
    const lines = [
      `In ${payload.month} the brand delivered ${String(now.ordersDelivered)} orders ` +
        `(${String(before.ordersDelivered)} the month before) worth ${taka(now.deliveredRevenuePoisha)}.`,
      `Return rate ${percent(now.returnRateBps)}, delivery success ${percent(now.deliverySuccessBps)}, ` +
        `ROAS ${multiple(now.roasBps)}.`,
      payload.leaderboard.rank === null
        ? 'The brand is not ranked this month.'
        : `It ranks ${String(payload.leaderboard.rank)} of ${String(payload.leaderboard.brands)} on the leaderboard.`,
      payload.insights.length === 0
        ? 'No rule flagged anything.'
        : `Flagged: ${payload.insights.map((insight) => insight.code).join(', ')}.`,
    ];
    return Promise.resolve(lines.join(' '));
  }

  clear(): void {
    this.prompts.length = 0;
  }
}
