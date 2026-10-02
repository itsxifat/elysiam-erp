import { describe, expect, it } from 'vitest';

import { PREVIEW_MARKER, refusal, type DatabaseIdentity } from './guard.js';

const nobody = { outsiders: 0, outsiderChanges: 0 };

const preview: DatabaseIdentity = {
  database: 'elysium_preview',
  oid: '16384',
  started: '2026-10-02 08:00:00+00',
  marker: PREVIEW_MARKER,
};

describe('refusal', () => {
  it('lets a marked preview through when both connections reach it', () => {
    expect(refusal(preview, { ...preview }, nobody, false)).toBeNull();
  });

  it.each([
    ['another database', { database: 'elysium' }],
    ['a database dropped and recreated under the same name', { oid: '99999' }],
    ['the same name on another cluster', { started: '2026-09-01 00:00:00+00' }],
  ])('refuses when the owner connection reaches %s', (_label, change) => {
    expect(refusal(preview, { ...preview, ...change }, nobody, false)).toMatch(
      /must name one database/,
    );
  });

  it('refuses a database not marked as a preview, and says how to mark one', () => {
    for (const marker of [null, '', 'production', 'Elysium-Preview']) {
      const reason = refusal({ ...preview, marker }, { ...preview, marker }, nobody, false);
      expect(reason).toContain('is not marked as a preview');
      expect(reason).toContain('docs/runbooks/preview-kit.md');
      // The refusal names where to read, not the command that would silence it.
      expect(reason).not.toContain('comment on database');
    }
  });

  it('refuses people from outside the preview unless asked to allow them', () => {
    const testers = { outsiders: 2, outsiderChanges: 0 };
    expect(refusal(preview, preview, testers, false)).toMatch(/2 person\(s\) outside the preview/);
    expect(refusal(preview, preview, testers, true)).toBeNull();
  });

  it('refuses work done by people outside the preview, whatever the flag says', () => {
    const work = { outsiders: 1, outsiderChanges: 3 };
    for (const allow of [false, true]) {
      expect(refusal(preview, preview, work, allow)).toMatch(/3 change\(s\).*Nothing overrides/);
    }
  });

  it('checks the marker before the people, so allowing people never skips it', () => {
    expect(
      refusal({ ...preview, marker: null }, { ...preview, marker: null }, nobody, true),
    ).toMatch(/not marked/);
  });
});
