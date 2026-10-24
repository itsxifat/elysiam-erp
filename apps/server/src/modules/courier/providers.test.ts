import { describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ NODE_ENV: 'production' }));
vi.mock('../../platform/config/env.js', () => ({ serverEnv: () => env }));

import { CourierAdapterRegistry } from './adapters/courier-adapter.js';
import { FakeCourierAdapter } from './adapters/fake.adapter.js';
import { SteadfastCourierAdapter } from './adapters/steadfast.adapter.js';
import { courierOffered, courierProviders } from './providers.js';

/** D-913: a brand's own ERP never offers the test courier beside Steadfast. */
describe('the couriers Settings → Couriers offers', () => {
  const adapters = new CourierAdapterRegistry([
    new FakeCourierAdapter(),
    new SteadfastCourierAdapter(),
  ]);

  it('leaves the fake courier out of a production process, and keeps it elsewhere', () => {
    env.NODE_ENV = 'production';
    expect(courierOffered('fake')).toBe(false);
    expect(courierProviders(adapters).map((item) => item.code)).toEqual(['steadfast', 'carrybee']);

    env.NODE_ENV = 'development';
    expect(courierOffered('fake')).toBe(true);
    expect(courierProviders(adapters).map((item) => item.code)).toContain('fake');
  });

  it('offers every real courier everywhere', () => {
    for (const nodeEnv of ['production', 'development', 'test']) {
      env.NODE_ENV = nodeEnv;
      for (const code of ['steadfast', 'pathao', 'redx', 'carrybee']) {
        expect(courierOffered(code), `${code} in ${nodeEnv}`).toBe(true);
      }
    }
  });
});
