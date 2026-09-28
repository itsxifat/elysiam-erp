import { Module, type Provider } from '@nestjs/common';

import { AuditService } from '../../platform/audit/audit.service.js';
import { FRAUD_API, FRAUD_GATE, FraudApiService } from './fraud.api.js';
import { FRAUD_CONFIG, fraudConfig } from './fraud.config.js';
import { FraudController } from './fraud.controller.js';
import { FraudService } from './fraud.service.js';
import { PhoneHashService } from './phone-hash.js';
import { FRAUD_PROVIDERS } from './providers/fraud-signal.provider.js';
import { ProviderGateway } from './providers/provider-gateway.js';
import { SteadfastFraudProvider } from './providers/steadfast.provider.js';

/**
 * Fraud check v1 (architecture §5 exception 1, §10; M13).
 *
 * Two things about this module's wiring are deliberate.
 *
 * **The configuration provider is a factory, so it runs at `app.init()`.** A missing
 * `FRAUD_PHONE_HASH_KEY` therefore stops the process rather than surfacing at the first
 * order. That is not defensiveness: a fallback key produces *different* hashes, so the
 * system keeps working while every phone number silently becomes a new person and five
 * brands' delivery history detaches from the buyers it describes. There is no migration
 * that repairs that, because a hash cannot be reversed to compare. A process that will
 * not start is the cheap failure. See `fraud.config.ts`.
 *
 * **Two tokens, one instance.** `FRAUD_API` is what a module that knows about fraud
 * injects. `FRAUD_GATE` is the symbol the *orders* module declares in its own port file
 * and injects without importing anything from here — which is what lets the order desk be
 * built and tested against a fake gate before this module exists. Both are bound to
 * `FraudApiService`, so there is one object and no chance of two with different state.
 */
const configProvider: Provider = { provide: FRAUD_CONFIG, useFactory: () => fraudConfig() };

/**
 * The providers this deployment has (D-010).
 *
 * Steadfast is listed but reports itself unconfigured until `FRAUD_STEADFAST_URL` and
 * `FRAUD_STEADFAST_API_KEY` are set — and until the endpoint has been verified against
 * real documentation, which it has not been (see the file's own header, and the decision
 * row). So on every deployment that exists today the score is internal-only and the badge
 * says so, which is a state the desk already handles rather than a broken integration.
 */
const providersProvider: Provider = {
  provide: FRAUD_PROVIDERS,
  useFactory: (steadfast: SteadfastFraudProvider) => [steadfast],
  inject: [SteadfastFraudProvider],
};

@Module({
  controllers: [FraudController],
  providers: [
    configProvider,
    providersProvider,
    PhoneHashService,
    SteadfastFraudProvider,
    ProviderGateway,
    /*
     * `AuditService` is listed here rather than imported from a module, because the
     * platform exposes it as a plain injectable the way the other modules take it. The
     * override record and its audit row are written in one transaction (check 5), so this
     * dependency is not optional.
     */
    AuditService,
    FraudService,
    FraudApiService,
    { provide: FRAUD_API, useExisting: FraudApiService },
    { provide: FRAUD_GATE, useExisting: FraudApiService },
  ],
  exports: [FRAUD_API, FRAUD_GATE, FraudService],
})
export class FraudModule {}
