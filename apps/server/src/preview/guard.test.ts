import { describe, expect, it } from 'vitest';

import { markerStatement, PREVIEW_MARKER, refusal, type DatabaseIdentity } from './guard.js';

const preview: DatabaseIdentity = {
  database: 'elysium_preview',
  oid: '16384',
  started: '2026-10-02 08:00:00+00',
  marker: PREVIEW_MARKER,
};

describe('refusal', () => {
  it('lets a marked preview through when both connections reach it', () => {
    expect(refusal(preview, { ...preview }, 0, false)).toBeNull();
  });

  it.each([
    ['another database', { database: 'elysium' }],
    ['a database dropped and recreated under the same name', { oid: '99999' }],
    ['the same name on another cluster', { started: '2026-09-01 00:00:00+00' }],
  ])('refuses when the owner connection reaches %s', (_label, change) => {
    expect(refusal(preview, { ...preview, ...change }, 0, false)).toMatch(/must name one database/);
  });

  it('refuses a database not marked as a preview, and says how to mark one', () => {
    for (const marker of [null, '', 'production', 'Elysium-Preview']) {
      const reason = refusal({ ...preview, marker }, { ...preview, marker }, 0, false);
      expect(reason).toContain('is not marked as a preview');
      expect(reason).toContain(`comment on database "elysium_preview" is '${PREVIEW_MARKER}'`);
    }
  });

  it('refuses people from outside the preview unless asked to allow them', () => {
    expect(refusal(preview, preview, 2, false)).toMatch(/2 person\(s\) outside the preview/);
    expect(refusal(preview, preview, 2, true)).toBeNull();
  });

  it('checks the marker before the people, so allowing people never skips it', () => {
    expect(refusal({ ...preview, marker: null }, { ...preview, marker: null }, 0, true)).toMatch(
      /not marked/,
    );
  });
});

describe('markerStatement', () => {
  it('quotes a plain name and refuses anything else', () => {
    expect(markerStatement('elysium_preview_e2e')).toBe(
      `comment on database "elysium_preview_e2e" is '${PREVIEW_MARKER}'`,
    );
    expect(() => markerStatement('x"; drop database elysium; --')).toThrow(/plain database name/);
  });
});
