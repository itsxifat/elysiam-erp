import { describe, expect, it, vi } from 'vitest';

import { drawsAttachment } from './inbox-attachment.js';

// The component reaches `api.ts`, which reads the console's env; the repo-root run has none.
vi.mock('../../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

describe('which attachments the voice and call views draw (D-780, D-784)', () => {
  it('draws calls, voice messages in every state, and kept or arriving pictures', () => {
    expect(drawsAttachment({ type: 'audio', media: 'pending' })).toBe(true);
    expect(drawsAttachment({ type: 'audio', media: 'failed' })).toBe(true);
    expect(drawsAttachment({ type: 'audio', fileId: 'f' })).toBe(true);
    expect(drawsAttachment({ type: 'image', media: 'stored', fileId: 'f' })).toBe(true);
    expect(drawsAttachment({ type: 'image', media: 'pending' })).toBe(true);
  });

  it('leaves everything else to the thread’s own line', () => {
    expect(drawsAttachment({ type: 'image', media: 'failed' })).toBe(false);
    expect(drawsAttachment({ type: 'image' })).toBe(false);
    expect(drawsAttachment({ type: 'audio' })).toBe(false);
    expect(drawsAttachment({ type: 'video', fileId: 'f' })).toBe(false);
    expect(drawsAttachment({ type: 'call' })).toBe(false);
  });
});
