import { z } from 'zod';

import type { JobFailureReporter, JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import type { InboxCallsService } from './calls.service.js';
import type { InboxMediaService } from './media.service.js';
import { VOICE_CALLS_QUEUES } from './voice-calls.queues.js';

/**
 * M45's handlers (D-780 to D-788). Payloads carry ids only: the attachment, the recording, the
 * token and the call are read from the tenant's own tables when the job runs (invariant 10).
 */
const mediaPayload = z.object({ mediaId: z.string().uuid() }).strict();
const voicePayload = z.object({ messageId: z.string().uuid() }).strict();
const callPayload = z.object({ callId: z.string().uuid() }).strict();

export interface VoiceCallsWorkerDependencies {
  readonly jobs: JobsRuntime;
  readonly media: InboxMediaService;
  readonly calls: InboxCallsService;
  readonly report: JobFailureReporter;
}

export async function registerVoiceCallsJobs(deps: VoiceCallsWorkerDependencies): Promise<void> {
  const { jobs, media, calls, report } = deps;
  const tenant = (name: string, orgId: string | null): string => {
    if (orgId === null) throw new Error(`${name} is tenant-scoped`);
    return orgId;
  };

  await jobs.work(
    VOICE_CALLS_QUEUES.fetchMedia.name,
    async (job) => {
      const orgId = tenant(VOICE_CALLS_QUEUES.fetchMedia.name, job.orgId);
      await media.fetch(orgId, mediaPayload.parse(job.payload).mediaId);
    },
    report,
  );
  await jobs.work(
    VOICE_CALLS_QUEUES.sendVoice.name,
    async (job) => {
      const orgId = tenant(VOICE_CALLS_QUEUES.sendVoice.name, job.orgId);
      await media.sendVoice(orgId, voicePayload.parse(job.payload).messageId);
    },
    report,
  );
  await jobs.work(
    VOICE_CALLS_QUEUES.callTimeout.name,
    async (job) => {
      const orgId = tenant(VOICE_CALLS_QUEUES.callTimeout.name, job.orgId);
      await calls.timeout(orgId, callPayload.parse(job.payload).callId);
    },
    report,
  );
  await jobs.work(
    VOICE_CALLS_QUEUES.mediaRetention.name,
    async () => {
      await media.retention();
    },
    report,
  );
}
