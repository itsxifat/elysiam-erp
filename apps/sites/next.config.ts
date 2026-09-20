import type { NextConfig } from 'next';

/**
 * Public landing pages (architecture §17). M29 adds multi-domain resolution,
 * ISR and on-demand revalidation; M00 only proves the toolchain.
 */
const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@elysium/ui', '@elysium/landing-blocks'],
};

export default config;
