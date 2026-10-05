import { randomBytes, randomUUID } from 'node:crypto';

import type { MembershipRole } from '@elysium/contracts';
import { withGlobal, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { PreviewCallError, type PreviewClient } from './client.js';
import { previewPassword } from './credentials.js';
import type { PreviewRuntime } from './runtime.js';

/**
 * Who the preview has, and how each of them gets in (D-382).
 *
 * **The owner's logins** — one per role, the people `preview-credentials.local.md` lists.
 * Every one but the super admin is invited through `POST /v1/users` and redeems the invite
 * through Better Auth's own reset endpoint, exactly as a brand's staff will be. Their
 * passwords are new on every run. The roles §6 walls behind a second factor (super admin,
 * org admin, accounts, investor) are **not** enrolled here: the owner sets up an
 * authenticator app at the first sign-in, as a real person does.
 *
 * **The seed's own hands** — a few "robot" staff the seed signs in as to do the work the
 * walled roles do (approve a payroll run, record a purchase cost). They enrol a second
 * factor in this process with a key that is never written down, so nobody can ever sign
 * in as one again; their names say "(preview seed)" wherever their work is shown.
 *
 * A super admin is a column, not a membership, and only `erp_owner` may set it (D-094):
 * there is no route that makes one, in this system or in production. So the first robot
 * and the owner's super admin are made the one way a deployment makes them — the user row
 * and the flag, as the owner role — and every other person comes through the invite.
 */

export const PREVIEW_EMAIL_DOMAIN = 'preview.elysium.test';

export type LoginKey =
  | 'superadmin'
  | 'admin'
  | 'accounts'
  | 'sales'
  | 'warehouse'
  | 'branch'
  | 'hr'
  | 'marketing'
  | 'investor';

export interface LoginSpec {
  readonly key: LoginKey;
  readonly email: string;
  readonly name: string;
  /** Absent for the super admin, who holds no membership. */
  readonly role?: MembershipRole;
  readonly label: string;
  readonly app: 'console' | 'portal' | 'till';
  readonly twoFactor: boolean;
  readonly note: string;
}

const at = (local: string) => `${local}@${PREVIEW_EMAIL_DOMAIN}`;

export const LOGINS: readonly LoginSpec[] = [
  {
    key: 'superadmin',
    email: at('superadmin'),
    name: 'Preview Super Admin',
    label: 'Super admin (owner)',
    app: 'console',
    twoFactor: true,
    note: 'The whole brand, the dashboards, every approval',
  },
  {
    key: 'admin',
    email: at('admin'),
    name: 'Preview Org Admin',
    role: 'org_admin',
    label: 'Org admin',
    app: 'console',
    twoFactor: true,
    note: 'Everything in one brand: products, approvals, dashboard',
  },
  {
    key: 'accounts',
    email: at('accounts'),
    name: 'Preview Accountant',
    role: 'accounts',
    label: 'Accounts',
    app: 'console',
    twoFactor: true,
    note: 'Wallets, cash book, purchases, COD settlements, investors, loans',
  },
  {
    key: 'sales',
    email: at('sales'),
    name: 'Preview Sales Agent',
    role: 'sales',
    label: 'Sales agent',
    app: 'console',
    twoFactor: false,
    note: 'Order desk, buyers, advance claims, own target',
  },
  {
    key: 'warehouse',
    email: at('warehouse'),
    name: 'Preview Warehouse',
    role: 'warehouse',
    label: 'Warehouse',
    app: 'console',
    twoFactor: false,
    note: 'Stock, transfers, packing and courier booking',
  },
  {
    key: 'branch',
    email: at('branch'),
    name: 'Preview Branch Manager',
    role: 'branch_manager',
    label: 'Branch manager',
    app: 'till',
    twoFactor: false,
    note: 'The showroom till, and the branch in the console',
  },
  {
    key: 'hr',
    email: at('hr'),
    name: 'Preview HR',
    role: 'hr',
    label: 'HR',
    app: 'console',
    twoFactor: false,
    note: 'People, attendance, payroll, targets, bonus rules',
  },
  {
    key: 'marketing',
    email: at('marketing'),
    name: 'Preview Marketing',
    role: 'marketing',
    label: 'Marketing',
    app: 'console',
    twoFactor: false,
    note: 'Campaigns, ad spend, leads, promo codes, SMS templates',
  },
  {
    key: 'investor',
    email: at('investor'),
    name: 'Preview Investor',
    role: 'investor',
    label: 'Investor',
    app: 'portal',
    twoFactor: true,
    note: 'The investor portal: capital, profit share, documents',
  },
];

export type RobotKey = 'root' | 'admin' | 'accounts' | 'hr';

const ROBOTS: Readonly<Record<RobotKey, { role?: MembershipRole; name: string }>> = {
  root: { name: 'Super Admin (preview seed)' },
  admin: { role: 'org_admin', name: 'Org Admin (preview seed)' },
  accounts: { role: 'accounts', name: 'Accountant (preview seed)' },
  hr: { role: 'hr', name: 'HR Officer (preview seed)' },
};

/** A signed-in browser, and who it is. */
export interface Session {
  readonly client: PreviewClient;
  readonly userId: string;
  readonly email: string;
}

/** RFC 4648 base32, as an authenticator app reads a setup key. */
function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of input.replace(/[\s=]/g, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('preview: a setup key is not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

async function userIdByEmail(email: string): Promise<string | undefined> {
  const rows = await withGlobal((tx) =>
    tx.execute<{ id: string }>(sql`select id from iam.users where email = ${email}`),
  );
  return rows[0]?.id;
}

export class People {
  private readonly passwords = new Map<string, string>();
  private readonly robots = new Map<RobotKey, Session>();
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly runtime: PreviewRuntime,
    private readonly orgId: string,
  ) {}

  /** The owner's logins with this run's passwords, for the credentials file. */
  credentials(): { spec: LoginSpec; password: string }[] {
    return LOGINS.map((spec) => ({ spec, password: this.passwords.get(spec.email) ?? '' }));
  }

  /**
   * A password, set through Better Auth's own reset flow so the library hashes it.
   * The same path `POST /v1/users` hands out an invite on (D-212).
   */
  private async setPassword(email: string, password: string, token?: string): Promise<void> {
    let resetToken = token;
    if (resetToken === undefined) {
      await this.runtime.auth.auth.api.requestPasswordReset({
        body: { email, redirectTo: '/accept-invite' },
      });
      resetToken = this.runtime.tokens.take(email);
    }
    if (resetToken === undefined) throw new Error(`preview: no password token for ${email}.`);
    await this.runtime.auth.auth.api.resetPassword({
      body: { newPassword: password, token: resetToken },
    });
  }

  /** A user row with the super admin flag, as the owner role sets it (D-094). */
  private async ensureSuperAdminRow(email: string, name: string): Promise<string> {
    const existing = await userIdByEmail(email);
    const id = existing ?? `usr_${randomUUID()}`;
    if (existing === undefined) {
      await withGlobal((tx) =>
        tx.execute(sql`
          insert into iam.users (id, email, name, email_verified)
          values (${id}, ${email}, ${name}, true)
        `),
      );
    }
    await withSystem((tx) =>
      tx.execute(sql`update iam.users set is_super_admin = true where id = ${id}`),
    );
    return id;
  }

  /** Sign in through the API, enrol a second factor if asked, and enter the org. */
  private async signIn(
    email: string,
    password: string,
    options: { enrol: boolean; orgId?: string },
  ): Promise<Session> {
    const client = this.runtime.client();
    await client.request('GET', '/v1/auth/login-branding');
    const signedIn = await client.request('POST', '/api/auth/sign-in/email', {
      body: { email, password },
    });
    if (signedIn.statusCode !== 200) {
      throw new PreviewCallError(
        'POST',
        '/api/auth/sign-in/email',
        signedIn.statusCode,
        signedIn.body,
      );
    }
    if (options.enrol) {
      const enabled = await client.call<{ totpURI: string }>(
        'POST',
        '/api/auth/two-factor/enable',
        {
          password,
          method: 'totp',
        },
      );
      const key = new URL(enabled.totpURI).searchParams.get('secret') ?? '';
      const secret = new TextDecoder().decode(base32Decode(key));
      const { code } = await this.runtime.auth.auth.api.generateTOTP({ body: { secret } });
      await client.call('POST', '/api/auth/two-factor/verify-totp', { code });
    }
    const userId = (await userIdByEmail(email)) ?? '';
    await client.post('/v1/me/active-org', { orgId: options.orgId ?? this.orgId });
    return { client, userId, email };
  }

  /**
   * One of the seed's own hands. Made on first use, so a re-run that finds everything
   * already seeded makes none. A robot left by an earlier run cannot sign in again (its
   * key was never kept), so a re-run that needs one makes a fresh one beside it.
   */
  async robot(key: RobotKey): Promise<Session> {
    const cached = this.robots.get(key);
    if (cached !== undefined) return cached;
    const spec = ROBOTS[key];
    let email = at(`seed.${key}`);
    for (let n = 2; (await userIdByEmail(email)) !== undefined; n += 1) {
      email = at(`seed.${key}.${String(n)}`);
    }
    // Never written anywhere: the robot exists for this process only.
    const password = randomBytes(24).toString('base64url');
    if (key === 'root') {
      await this.ensureSuperAdminRow(email, spec.name);
      await this.setPassword(email, password);
    } else {
      const root = await this.robot('root');
      const invited = await root.client.post<{ inviteToken?: string }>('/v1/users', {
        email,
        name: spec.name,
        role: spec.role,
        branchIds: [],
      });
      await this.setPassword(
        email,
        password,
        invited.inviteToken ?? this.runtime.tokens.take(email),
      );
    }
    const session = await this.signIn(email, password, { enrol: true });
    this.robots.set(key, session);
    return session;
  }

  /**
   * Make every login exist, with a new password. Idempotent: an existing person keeps
   * their account (and any second factor they enrolled), and only the password changes.
   */
  async ensureLogins(options: {
    readonly branchIds: Readonly<Record<string, string>>;
  }): Promise<void> {
    for (const spec of LOGINS) {
      const password = previewPassword();
      this.passwords.set(spec.email, password);
      const existing = await userIdByEmail(spec.email);
      if (spec.role === undefined) {
        await this.ensureSuperAdminRow(spec.email, spec.name);
        await this.setPassword(spec.email, password);
        continue;
      }
      if (existing !== undefined) {
        await this.setPassword(spec.email, password);
        continue;
      }
      const root = await this.robot('root');
      const branchId = options.branchIds[spec.key];
      const invited = await root.client.post<{ inviteToken?: string }>('/v1/users', {
        email: spec.email,
        name: spec.name,
        role: spec.role,
        branchIds: branchId === undefined ? [] : [branchId],
      });
      await this.setPassword(
        spec.email,
        password,
        invited.inviteToken ?? this.runtime.tokens.take(spec.email),
      );
    }
  }

  /**
   * Retire every robot: inactive, and no longer super admin, as the owner role (the one
   * channel that may change the flag, D-094). An inactive user resolves to no context, so
   * a robot can do nothing once retired; its name stays on the work it did. Called before
   * a run (a crashed run's robots) and after it, so robots never accumulate live.
   */
  async retireRobots(): Promise<number> {
    this.robots.clear();
    const robots = sql`select id from iam.users where email like ${`seed.%@${PREVIEW_EMAIL_DOMAIN}`}`;
    // Their memberships too, so a retired robot holds no role. Inside the brand's context:
    // memberships are FORCE RLS, and an update without one would match nothing. Robots are
    // only ever members of this brand.
    await withSystem(
      (tx) =>
        tx.execute(sql`
          update iam.memberships set is_active = false
          where user_id in (${robots}) and is_active
        `),
      { orgId: this.orgId },
    );
    const retired = await withSystem((tx) =>
      tx.execute<{ id: string }>(sql`
        update iam.users set is_active = false, is_super_admin = false
        where id in (${robots}) and (is_active or is_super_admin)
        returning id
      `),
    );
    return retired.length;
  }

  /** The user id behind a login. */
  async idOf(key: LoginKey): Promise<string> {
    const spec = LOGINS.find((entry) => entry.key === key);
    const id = spec === undefined ? undefined : await userIdByEmail(spec.email);
    if (id === undefined) throw new Error(`preview: no ${key} login yet.`);
    return id;
  }

  /**
   * Act as one of the owner's logins. Only the roles with no second factor: the walled
   * ones are left for the owner to enrol, and their work is done by a robot.
   */
  async as(key: LoginKey): Promise<Session> {
    const spec = LOGINS.find((entry) => entry.key === key);
    if (spec === undefined || spec.twoFactor) {
      throw new Error(`preview: ${key} has a second factor; use a robot for its work.`);
    }
    const cached = this.sessions.get(key);
    if (cached !== undefined) return cached;
    const password = this.passwords.get(spec.email);
    if (password === undefined) throw new Error('preview: ensureLogins() first.');
    const session = await this.signIn(spec.email, password, { enrol: false });
    this.sessions.set(key, session);
    return session;
  }
}
