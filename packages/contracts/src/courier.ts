import { z } from 'zod';

/**
 * Connecting a courier from Settings → Couriers (D-913).
 *
 * The owner's words: choose the courier, add its keys, and it is connected; say whether it is
 * the default. So the request is the courier's code, its keys and the default switch, and
 * nothing else: the label, the mode, the base URL, the polling hours and the settlement wallet
 * are the server's defaults (`POST /v1/courier/accounts` still takes them all, for anyone who
 * needs to change one).
 *
 * Which keys a courier takes is the courier's adapter's business (`credentialFields` on
 * `GET /v1/courier/providers`), so the map is checked against it by the server, which refuses a
 * missing key or one the courier does not take, naming them. The shape here bounds what can
 * arrive at all: a short camelCase name, a value of 1 to 500 characters with the paste's stray
 * spaces trimmed, at most ten of them.
 */

/** How a courier is connected: through its API, or booked by hand in its own merchant panel. */
export const COURIER_CONNECT_KINDS = ['api', 'panel'] as const;
export type CourierConnectKind = (typeof COURIER_CONNECT_KINDS)[number];

export const connectCourierSchema = z
  .object({
    /** The courier's code from `GET /v1/courier/providers`: `steadfast`, `pathao`, `carrybee`. */
    provider: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, 'Choose a courier from the list.'),
    credentials: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9]{0,39}$/, 'That is not a key this courier takes.'),
        z.string().trim().min(1, 'Fill in every key.').max(500, 'A key is at most 500 characters.'),
      )
      .refine((keys) => Object.keys(keys).length <= 10, 'Too many keys.')
      .default({}),
    /** Make it the brand's default courier: every delivery zone's, so each new order gets it. */
    isDefault: z.boolean().default(false),
  })
  .strict();
export type ConnectCourierInput = z.infer<typeof connectCourierSchema>;

/** What `POST /v1/courier/connections` answers. */
export interface ConnectCourierResult {
  readonly courierId: string;
  /** Null for a courier booked in its own panel (Carrybee): there is no account to hold keys. */
  readonly accountId: string | null;
  /** True when the courier accepted the keys and the account is active. */
  readonly connected: boolean;
  /** Whether it is the brand's default courier now. */
  readonly isDefault: boolean;
  /** One plain sentence for the screen. */
  readonly message: string;
}
