import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Tx } from '@elysium/db';

import { BrandLogoRegistry, type BrandLogoPort } from '../orders/ports/brand-logo.port.js';
import { StorefrontService } from './storefront.service.js';

/**
 * The website's logo, for the order documents (M43, D-754).
 *
 * The orders module renders the invoice, packing slip and label, and may not read this
 * module's settings (invariant 12); it cannot import this module either, because this one
 * imports it. So this registers itself in the orders module's registry at startup.
 */
@Injectable()
export class BrandLogoBinding implements BrandLogoPort, OnModuleInit {
  constructor(
    private readonly registry: BrandLogoRegistry,
    private readonly storefront: StorefrontService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async websiteLogoFileId(tx: Tx, orgId: string): Promise<string | null> {
    const settings = await this.storefront.settingsIn(tx, orgId);
    return settings.siteInfo.logoFileId;
  }
}
