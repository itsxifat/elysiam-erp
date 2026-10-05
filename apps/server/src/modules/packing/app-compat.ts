import { HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

/**
 * The packing scanner app as it ships (M35b, D-554): its APK calls the old site's
 * `/api/admin/scanner/login` and `/api/admin/scanner/shipment` and reads a refusal's words
 * from `error`. The ERP answers those two paths with the same work as `/v1/scanner/sign-in`
 * and `/v1/scanner/shipment`, and its refusals as `{ error, code }`, so pointing the app at the
 * brand's admin host is the only change it needs.
 */
export const SCANNER_APP_PREFIX = '/api/admin/scanner/';

/** Run the handler; a refusal is answered in the old app's words, anything else is thrown. */
export async function answerForApp(
  reply: FastifyReply,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    await reply.code(200).send(await work());
  } catch (error) {
    if (!(error instanceof HttpException) || error.getStatus() >= 500) throw error;
    const body = error.getResponse() as { code?: unknown; message?: unknown } | string;
    const message =
      typeof body === 'string'
        ? body
        : typeof body.message === 'string'
          ? body.message
          : error.message;
    const code = typeof body === 'object' && typeof body.code === 'string' ? body.code : null;
    await reply.code(error.getStatus()).send({ error: message, code });
  }
}
