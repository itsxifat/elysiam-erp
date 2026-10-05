import { Injectable } from '@nestjs/common';
import type { UsageEntry, UsageReport } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { SYSTEM_SMS_TEMPLATE_KEYS } from '@elysium/domain/notify';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { describeUses, mergeUses } from '../../platform/references/references.js';
import { mapNotifyErrors, NotifyError } from './notify.errors.js';
import * as refs from './references.repository.js';

/**
 * Deleting an SMS template (M39a, D-632): only one that was never sent and that the system
 * does not send by itself (a sign-in code, an occasion greeting, a loan reminder). Anything
 * else is switched off instead, which the template editor already does; 0119's trigger
 * refuses the delete of a sent template for every role.
 */
@Injectable()
export class TemplateDeletesService {
  constructor(private readonly audit: AuditService) {}

  async usage(context: ActiveContext, id: string): Promise<UsageReport> {
    return mapNotifyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const template = await refs.lockTemplate(tx, context.orgId, id, false);
        if (template === undefined) throw notFound();
        const uses = await this.uses(tx, context.orgId, template);
        return {
          kind: 'sms_template',
          id,
          label: template.key,
          archived: !template.is_active,
          canDelete: uses.length === 0,
          canEmptyAndDelete: false,
          canArchive: template.is_active,
          uses,
        };
      }),
    );
  }

  async delete(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapNotifyErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const template = await refs.lockTemplate(tx, context.orgId, id);
        if (template === undefined) throw notFound();
        const uses = await this.uses(tx, context.orgId, template);
        if (uses.length > 0) {
          throw new NotifyError(
            'NOTIFY_IN_USE',
            `${template.key} has ${describeUses(uses)}. Switch it off instead.`,
          );
        }
        if (!(await refs.deleteTemplate(tx, context.orgId, id))) throw notFound();
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'notify.template.deleted',
          entityType: 'MessageTemplate',
          entityId: id,
          before: { ...template },
          after: null,
          requestId: context.requestId,
          request,
        });
        return { id, deleted: true };
      }),
    );
  }

  private async uses(tx: Tx, orgId: string, template: refs.TemplateImage): Promise<UsageEntry[]> {
    const system = template.category === 'otp' || SYSTEM_SMS_TEMPLATE_KEYS.includes(template.key);
    return mergeUses([
      { reason: 'messages_sent', count: await refs.messagesWithKey(tx, orgId, template.key) },
      { reason: 'system_template', count: system ? 1 : 0 },
    ]);
  }
}

function notFound(): NotifyError {
  return new NotifyError('NOT_FOUND', 'No such template.');
}
