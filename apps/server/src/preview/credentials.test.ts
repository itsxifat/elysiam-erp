import { describe, expect, it } from 'vitest';

import {
  credentialsMarkdown,
  previewPassword,
  previewUrls,
  type PreviewLogin,
} from './credentials.js';

describe('previewPassword', () => {
  it('is four groups of five, without the characters people misread', () => {
    for (let run = 0; run < 200; run += 1) {
      const password = previewPassword();
      expect(password).toMatch(/^[A-Za-z0-9]{5}(-[A-Za-z0-9]{5}){3}$/);
      expect(password).not.toMatch(/[0O1lI]/);
    }
  });

  it('is new every time', () => {
    const seen = new Set(Array.from({ length: 100 }, () => previewPassword()));
    expect(seen.size).toBe(100);
  });
});

describe('previewUrls', () => {
  it('uses the dev servers when the API is local or unnamed', () => {
    const local = {
      console: 'http://localhost:5173',
      portal: 'http://localhost:5174',
      till: 'http://localhost:5175',
    };
    expect(previewUrls({})).toEqual(local);
    expect(previewUrls({ API_PUBLIC_URL: 'http://localhost:3000' })).toEqual(local);
  });

  it('uses the preview server’s one-origin layout for a public API (D-352)', () => {
    expect(previewUrls({ API_PUBLIC_URL: 'https://elyerp.example.test' })).toEqual({
      console: 'https://elyerp.example.test/',
      portal: 'https://elyerp.example.test/portal',
      till: 'https://elyerp.example.test/pos',
    });
  });

  it('lets each address be named outright', () => {
    expect(
      previewUrls({
        API_PUBLIC_URL: 'https://elyerp.example.test',
        PREVIEW_CONSOLE_URL: 'http://localhost:5193',
        PREVIEW_PORTAL_URL: 'http://localhost:5194',
        PREVIEW_POS_URL: 'http://localhost:5195',
      }),
    ).toEqual({
      console: 'http://localhost:5193',
      portal: 'http://localhost:5194',
      till: 'http://localhost:5195',
    });
  });
});

describe('credentialsMarkdown', () => {
  const logins: PreviewLogin[] = [
    {
      label: 'Org admin',
      email: 'admin@preview.elysium.test',
      password: 'Abcde-Fghjk-Mnpqr-Stuvw',
      app: 'console',
      twoFactor: true,
      note: 'Everything in one brand',
    },
    {
      label: 'Investor',
      email: 'investor@preview.elysium.test',
      password: 'Zyxwv-Tsrqp-Nmkjh-Gfedc',
      app: 'portal',
      twoFactor: true,
      note: 'The investor portal',
    },
    {
      label: 'Branch manager',
      email: 'branch@preview.elysium.test',
      password: 'Qwert-Yuiop-Asdfg-Hjkzx',
      app: 'till',
      twoFactor: false,
      note: 'The showroom till',
    },
  ];
  const urls = {
    console: 'https://elyerp.example.test/',
    portal: 'https://elyerp.example.test/portal',
    till: 'https://elyerp.example.test/pos',
  };
  const at = new Date('2026-10-02T15:00:00Z');

  it('lists each login with the app it opens, its password and its two-step line', () => {
    const text = credentialsMarkdown(logins, urls, { brand: 'Elysiam Lifestyle BD' }, at);
    expect(text).toContain(
      '| Org admin | https://elyerp.example.test/ | `admin@preview.elysium.test` | `Abcde-Fghjk-Mnpqr-Stuvw` | Yes, on first sign-in |',
    );
    expect(text).toContain('| Investor | https://elyerp.example.test/portal |');
    expect(text).toContain(
      '| Branch manager | https://elyerp.example.test/pos | `branch@preview.elysium.test` | `Qwert-Yuiop-Asdfg-Hjkzx` | No |',
    );
    expect(text).toContain('on 2026-10-02 15:00 UTC');
  });

  it('names an order to track, at the portal’s tracking page', () => {
    const text = credentialsMarkdown(
      logins,
      urls,
      {
        brand: 'Elysiam Lifestyle BD',
        tracking: { orderNo: 'ELY-2610-00005', phoneLast4: '0105', slug: 'elysium-lifestyle-bd' },
      },
      at,
    );
    expect(text).toContain(
      'Open https://elyerp.example.test/portal/track/elysium-lifestyle-bd and type order number `ELY-2610-00005` and phone digits `0105`',
    );
  });

  it('mentions the training brand only when it was imported', () => {
    const without = credentialsMarkdown(logins, urls, { brand: 'Elysiam Lifestyle BD' }, at);
    const withTraining = credentialsMarkdown(
      logins,
      urls,
      { brand: 'Elysiam Lifestyle BD', training: true },
      at,
    );
    expect(without).toContain('the other four brands.');
    expect(withTraining).toContain('the other four brands and the training brand.');
  });
});
