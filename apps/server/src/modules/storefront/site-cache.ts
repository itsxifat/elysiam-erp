import { Injectable } from '@nestjs/common';

/**
 * The website's `site` answer, kept for thirty seconds per brand (M33, D-506).
 *
 * Settings, slides and the menu change a few times a day and are read on every page the
 * website renders, so the assembled, serialised answer is kept in the process. Thirty seconds
 * is the same as the `max-age` the website is told, so nothing here is staler than what the
 * website may already hold. A write through this process forgets its brand at once; another
 * process's copy runs out on its own. Never stock: availability is read live on every call.
 */
@Injectable()
export class SiteCache {
  static readonly TTL_MS = 30_000;

  private readonly entries = new Map<string, { readonly body: string; readonly expires: number }>();

  get(orgId: string, now: number = Date.now()): string | undefined {
    const entry = this.entries.get(orgId);
    if (entry === undefined || entry.expires <= now) {
      this.entries.delete(orgId);
      return undefined;
    }
    return entry.body;
  }

  set(orgId: string, body: string, now: number = Date.now()): void {
    // Bounded by the number of brands a process serves, which is one in production (D-469).
    if (this.entries.size > 64) this.entries.clear();
    this.entries.set(orgId, { body, expires: now + SiteCache.TTL_MS });
  }

  forget(orgId: string): void {
    this.entries.delete(orgId);
  }
}
