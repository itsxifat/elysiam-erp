/**
 * @elysium/integrations
 *
 * Adapters behind interfaces: couriers, fraud providers, SMS, Meta, Chatwoot
 * and payment. Every adapter ships an interface, a real implementation and a
 * fake (architecture §4, §21).
 *
 * M04 adds object storage (§22). M12 adds the first CourierAdapter; M13 adds
 * FraudSignalProvider.
 */
export const PACKAGE_NAME = '@elysium/integrations' as const;

export * from './storage/index.js';
