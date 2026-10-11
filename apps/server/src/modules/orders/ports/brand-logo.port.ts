import { Injectable } from '@nestjs/common';
import type { Tx } from '@elysium/db';

/**
 * Where the order documents find the brand's logo (M43, D-754).
 *
 * The brand block's own `logoFileId` (D-034) comes first; no screen sets it yet, so a brand's
 * logo today is the one uploaded under Website → Settings, which the storefront module owns.
 * That module imports this one (its order emails ask `ORDERS_API`), so it cannot be imported
 * back; it registers this port at startup instead, the way the courier module registers its
 * booking port (`courier-booking.port.ts`). With nothing registered, a document prints the
 * brand's name alone.
 */
export interface BrandLogoPort {
  /** The website's logo, a stored public image of this brand, or null when it has none. */
  websiteLogoFileId(tx: Tx, orgId: string): Promise<string | null>;
}

@Injectable()
export class BrandLogoRegistry {
  private port: BrandLogoPort | undefined;

  register(port: BrandLogoPort): void {
    if (this.port !== undefined && this.port !== port) {
      throw new Error('a brand logo port is already registered');
    }
    this.port = port;
  }

  /** The registered port, or undefined when this deployment has no storefront module. */
  current(): BrandLogoPort | undefined {
    return this.port;
  }
}
