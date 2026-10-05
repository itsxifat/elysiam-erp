import { Module, type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { issueStorefrontKeySchema } from '@elysium/contracts';

import { BrandDeploymentError, commandBrand } from '../../platform/brand/deployment.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { FilesModule } from '../files/files.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { SiteCache } from './site-cache.js';
import { STOREFRONT_CONFIG, storefrontConfig, type StorefrontConfig } from './storefront.config.js';
import { StorefrontError } from './storefront.errors.js';
import { normaliseSiteUrl, StorefrontService } from './storefront.service.js';

/**
 * The brand's website, connected from the server (D-582): `main.admin.ts`'s `website-key` and
 * `website-site-url`.
 *
 * The website is a separate app on the same server, and it needs a site key whose secret the
 * console shows once on screen (Website → Connection). Run here instead, the secret goes from
 * this process's stdout straight into the website's root-only env file and is never displayed
 * or copied. Both commands go through `StorefrontService`, the console's own code: the same
 * key derivation, fingerprint row and in-transaction audit row as `POST
 * /v1/storefront/site-keys`, and the same lock, merge and audit as a Website → Settings save.
 * The actor is a system actor, `system:admin-cli`, and each audit row says `via: 'cli'`.
 *
 * The service is booted in an application context of its own, no HTTP, the way `pnpm
 * migration` boots its importers, against `DATABASE_URL` as `erp_app` inside the brand's
 * row-level security. The brand is `ERP_BRAND_SLUG`, else the database's one brand
 * (`commandBrand`).
 */

export const WEBSITE_CLI_ACTOR = 'system:admin-cli';

/** A refusal the operator can act on; printed as one sentence, never with a stack. */
export class WebsiteAdminRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebsiteAdminRefused';
  }
}

/** The storefront service and what it reaches, without the website's HTTP side. */
@Module({})
export class WebsiteAdminModule {
  static register(config: StorefrontConfig): DynamicModule {
    return {
      module: WebsiteAdminModule,
      imports: [CatalogModule, OrdersModule, FilesModule, ApprovalsModule],
      providers: [
        // The configuration the command checked, so the check and the service cannot disagree.
        { provide: STOREFRONT_CONFIG, useValue: config },
        SiteCache,
        StorefrontService,
      ],
    };
  }
}

export interface IssuedWebsiteKey {
  readonly orgId: string;
  readonly brandSlug: string;
  /** The key's row id, for Website → Connection. */
  readonly id: string;
  readonly label: string;
  /** Public: `pk_<org id>_…`. */
  readonly keyId: string;
  /** Derived from `INTAKE_KEY_SECRET`; stored nowhere, returned here once. */
  readonly secret: string;
}

export interface SavedSiteUrl {
  readonly orgId: string;
  readonly brandSlug: string;
  readonly siteUrl: string;
}

/** A website key for the deployment's brand, issued the way the console issues one. */
export async function issueWebsiteKey(label: string): Promise<IssuedWebsiteKey> {
  const parsed = issueStorefrontKeySchema.safeParse({ label });
  if (!parsed.success) {
    throw new WebsiteAdminRefused(
      parsed.error.issues[0]?.message ?? 'A key needs a label of up to 120 characters.',
    );
  }
  const config = configured();
  if (config.INTAKE_KEY_SECRET === undefined) {
    throw new WebsiteAdminRefused(
      'INTAKE_KEY_SECRET is not set, and every website key is derived from it. Set it in this ' +
        "deployment's environment (BRAND_INTAKE_KEY_SECRET in the brand's .env.brand) and run " +
        'this again.',
    );
  }
  const brand = await brandOf();
  return withStorefront(config, async (service) => {
    const issued = await service.issueKey(
      { orgId: brand.id, userId: WEBSITE_CLI_ACTOR },
      undefined,
      parsed.data.label,
      'cli',
    );
    return {
      orgId: brand.id,
      brandSlug: brand.slug,
      id: issued.id,
      label: issued.label,
      keyId: issued.keyId,
      secret: issued.secret,
    };
  });
}

/** Website → Settings' Site URL for the deployment's brand, saved as the console saves it. */
export async function setWebsiteSiteUrl(url: string): Promise<SavedSiteUrl> {
  // The address first: a typo is refused before the database or the modules are touched.
  const value = refusing(() => normaliseSiteUrl(url));
  const config = configured();
  const brand = await brandOf();
  const saved = await withStorefront(config, async (service) =>
    service.setSiteUrl({ orgId: brand.id, userId: WEBSITE_CLI_ACTOR }, value, 'cli'),
  );
  // Read back as the website's links will read it. Only stored site details that no longer
  // parse would differ, and then every link built from it would be wrong: say so.
  if (saved.siteInfo.siteUrl !== value) {
    throw new WebsiteAdminRefused(
      `The Site URL was saved, but the brand's site details read back with "${saved.siteInfo.siteUrl}". ` +
        'Open Website → Settings, check the site details and save them again.',
    );
  }
  return { orgId: brand.id, brandSlug: brand.slug, siteUrl: value };
}

/**
 * The two lines a website's env file takes, and nothing else. The website reads these two
 * names (`ERP_SITE_KEY_ID`, `ERP_SITE_SECRET`); neither value can hold a newline or a quote
 * (`pk_<uuid>_<hex>`, `sk_<base64url>`), so no quoting is needed.
 */
export function siteKeyEnvLines(key: Pick<IssuedWebsiteKey, 'keyId' | 'secret'>): string {
  return `ERP_SITE_KEY_ID=${key.keyId}\nERP_SITE_SECRET=${key.secret}\n`;
}

/** Where a command writes: stdout for what is piped on, stderr for the operator. */
export interface CommandOutput {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/**
 * `website-key --label "<label>"`. Stdout is exactly the two env lines, so it can be piped
 * into the website's env file; the key id, for the operator, goes to stderr.
 */
export async function websiteKeyCommand(
  label: string | undefined,
  io: CommandOutput,
): Promise<void> {
  if (label === undefined) throw new WebsiteAdminRefused('--label "<label>" is required.');
  const key = await issueWebsiteKey(label);
  io.err(
    [
      `Website key ${key.keyId} ("${key.label}") issued for ${key.brandSlug}.`,
      'Its secret is on stdout only and is stored nowhere. If it did not reach the website’s',
      'env file, revoke this key on Website → Connection and issue another.',
      '',
    ].join('\n'),
  );
  io.out(siteKeyEnvLines(key));
}

/** `website-site-url --url https://…`. Stdout is the saved address. */
export async function websiteSiteUrlCommand(
  url: string | undefined,
  io: CommandOutput,
): Promise<void> {
  if (url === undefined) throw new WebsiteAdminRefused('--url https://… is required.');
  const saved = await setWebsiteSiteUrl(url);
  io.err(`Site URL of ${saved.brandSlug} saved (Website → Settings).\n`);
  io.out(`${saved.siteUrl}\n`);
}

/** A storefront refusal as the operator's one sentence. */
function refusing<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof StorefrontError) throw new WebsiteAdminRefused(error.message);
    throw error;
  }
}

function configured(): StorefrontConfig {
  try {
    return storefrontConfig();
  } catch (error) {
    throw new WebsiteAdminRefused(error instanceof Error ? error.message : String(error));
  }
}

async function brandOf() {
  try {
    return await commandBrand(process.env.ERP_BRAND_SLUG);
  } catch (error) {
    if (error instanceof BrandDeploymentError) throw new WebsiteAdminRefused(error.message);
    throw error;
  }
}

async function withStorefront<T>(
  config: StorefrontConfig,
  fn: (service: StorefrontService) => Promise<T>,
): Promise<T> {
  const context = await NestFactory.createApplicationContext(WebsiteAdminModule.register(config), {
    logger: false,
    abortOnError: false,
  });
  try {
    return await fn(context.get(StorefrontService));
  } catch (error) {
    // The service's refusals are sentences meant for a person; anything else is a failure.
    if (error instanceof StorefrontError) throw new WebsiteAdminRefused(error.message);
    throw error;
  } finally {
    // After a key's row has committed, a failure to shut the modules down must not hide the
    // key from the operator: the command still prints it, and the process exits anyway.
    await context.close().catch(() => undefined);
  }
}
