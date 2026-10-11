import {
  Button,
  DataTable,
  Dialog,
  PermissionGate,
  Select,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  EDITABLE_TEMPLATE_CATEGORIES,
  listTemplates,
  upsertTemplate,
  type EditableTemplateCategory,
  type MessageTemplate,
} from './api.js';
import {
  CampaignsHeader,
  control,
  Field,
  singlePage,
  useCampaignTableLabels,
} from './campaigns-nav.js';
import { useCampaignsT, type CampaignsMessageKey } from './messages.js';
import { deleteTemplate, templateUsage } from '../../api/manage.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/manage.js';
import { DeleteOrArchive } from '../../ui/delete-or-archive.js';

/**
 * Message templates (M16; D-205): what each SMS says, in Bangla and English.
 *
 * Buyers receive Bangla (D-036); the English is for staff reading the log. A template is
 * keyed by its name, so saving one with an existing key replaces it — which is how an
 * edit works, and why the key is read-only once the template exists.
 */
export function TemplatesPage() {
  const ability = useAbility();
  const t = useCampaignsT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Campaign')}
      explain={{ title: t('campaigns.deniedTitle'), detail: t('campaigns.deniedDetail') }}
    >
      <Templates />
    </PermissionGate>
  );
}

const KEY = /^[a-z][a-z0-9_.]{2,63}$/;

function Templates() {
  const t = useCampaignsT();
  const ability = useAbility();
  const canEdit = ability.can('update', 'Campaign');
  const canDelete = ability.can('delete', 'Campaign');
  const [editing, setEditing] = useState<MessageTemplate | 'new' | null>(null);
  // M39a (D-632): a template that never went out can be deleted; otherwise switched off.
  const [managing, setManaging] = useState<MessageTemplate | null>(null);
  const tm = useT();
  const queryClient = useQueryClient();

  const templates = useQuery({ queryKey: ['campaigns', 'templates'], queryFn: listTemplates });

  const columns = useMemo<readonly DataTableColumn<MessageTemplate>[]>(() => {
    const column = dataTableColumns<MessageTemplate>();
    return column.columns([
      column.accessor('key', {
        header: t('campaigns.templates.col.key'),
        cell: (cell) => <span className="font-mono text-sm">{cell.getValue()}</span>,
      }),
      column.accessor('category', {
        header: t('campaigns.templates.col.category'),
        cell: (cell) => t(`campaigns.templates.category.${cell.getValue()}` as CampaignsMessageKey),
      }),
      column.accessor('bodyEn', {
        header: t('campaigns.templates.col.body'),
        cell: (cell) => <span className="line-clamp-2 max-w-md">{cell.getValue()}</span>,
      }),
      column.accessor('isActive', {
        header: t('campaigns.templates.col.active'),
        cell: (cell) => (
          <StatusBadge tone={cell.getValue() ? 'success' : 'neutral'}>
            {cell.getValue() ? t('campaigns.templates.yes') : t('campaigns.templates.no')}
          </StatusBadge>
        ),
      }),
      column.display({
        id: 'edit',
        header: '',
        cell: (cell) =>
          canEdit && cell.row.original.category !== 'otp' ? (
            <span className="inline-flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditing(cell.row.original)}>
                {t('campaigns.templates.edit')}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={tm('mg.setup.manageNamed').replace('{name}', cell.row.original.key)}
                title={tm('mg.setup.manage')}
                onClick={() => setManaging(cell.row.original)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </span>
          ) : null,
      }),
    ]);
  }, [t, tm, canEdit]);

  const items = templates.data?.items ?? [];
  const labels = useCampaignTableLabels(
    t('campaigns.templates.emptyTitle'),
    t('campaigns.templates.emptyDetail'),
  );

  return (
    <div className="space-y-5">
      <CampaignsHeader
        title={t('campaigns.nav.templates')}
        caption={t('campaigns.templates.subtitle')}
        actions={
          canEdit ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus aria-hidden="true" />
              {t('campaigns.templates.new')}
            </Button>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        data={items}
        getRowId={(row) => row.id}
        page={singlePage(items.length)}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        loading={templates.isPending}
        error={templates.error}
        onRetry={() => void templates.refetch()}
        caption={t('campaigns.nav.templates')}
        labels={labels}
      />
      {editing === null ? null : (
        <TemplateDialog
          template={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {managing === null ? null : (
        <DeleteOrArchive
          key={managing.id}
          open
          onClose={() => setManaging(null)}
          queryKey={['campaigns', 'templates', managing.id]}
          loadUsage={() => templateUsage(managing.id)}
          onDelete={canDelete ? () => deleteTemplate(managing.id) : undefined}
          onArchive={() => switchTemplate(managing, false)}
          onRestore={() => switchTemplate(managing, true)}
          onDone={() =>
            void queryClient.invalidateQueries({ queryKey: ['campaigns', 'templates'] })
          }
        />
      )}
    </div>
  );
}

/** Switch a template off (its archive) or back on, keeping everything else (D-632). */
function switchTemplate(template: MessageTemplate, isActive: boolean) {
  return upsertTemplate({
    key: template.key,
    category: template.category === 'otp' ? 'transactional' : template.category,
    bodyEn: template.bodyEn,
    isActive,
  });
}

function TemplateDialog({
  template,
  onClose,
}: {
  readonly template: MessageTemplate | null;
  readonly onClose: () => void;
}) {
  const t = useCampaignsT();
  const queryClient = useQueryClient();
  const id = useId();
  const [key, setKey] = useState(template?.key ?? '');
  const [category, setCategory] = useState<EditableTemplateCategory>(
    template === null || template.category === 'otp' ? 'marketing' : template.category,
  );
  const [bodyEn, setBodyEn] = useState(template?.bodyEn ?? '');
  const [isActive, setIsActive] = useState(template?.isActive ?? true);
  const [errors, setErrors] = useState<{ key?: CampaignsMessageKey; body?: CampaignsMessageKey }>(
    {},
  );
  const [failure, setFailure] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: upsertTemplate,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['campaigns', 'templates'] });
      onClose();
    },
    onError: (error) => {
      setFailure(error instanceof ApiError ? error.message : t('campaigns.templates.form.failed'));
    },
  });

  function submit() {
    setFailure(null);
    const next: typeof errors = {};
    if (!KEY.test(key.trim())) next.key = 'campaigns.templates.form.invalidKey';
    if (bodyEn.trim() === '') next.body = 'campaigns.templates.form.required';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate({
      key: key.trim(),
      category,
      bodyEn: bodyEn.trim(),
      isActive,
    });
  }

  const area = `${control} h-24 py-1.5`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={template === null ? t('campaigns.templates.new') : t('campaigns.templates.editTitle')}
      closeLabel={t('campaigns.close')}
      className="max-w-xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('campaigns.cancel')}
          </Button>
          <Button onClick={submit} disabled={save.isPending}>
            {t('campaigns.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('campaigns.templates.form.key')}
          id={`${id}-key`}
          hint={t('campaigns.templates.form.keyHint')}
          error={errors.key === undefined ? undefined : t(errors.key)}
        >
          <input
            id={`${id}-key`}
            className={`${control} font-mono`}
            value={key}
            readOnly={template !== null}
            aria-invalid={errors.key !== undefined}
            aria-describedby={errors.key === undefined ? undefined : `${id}-key-error`}
            onChange={(event) => setKey(event.target.value)}
          />
        </Field>
        <Field label={t('campaigns.templates.col.category')} id={`${id}-category`}>
          <Select
            id={`${id}-category`}
            value={category}
            onValueChange={(value) => setCategory(value as EditableTemplateCategory)}
            options={EDITABLE_TEMPLATE_CATEGORIES.map((value) => ({
              value,
              label: t(`campaigns.templates.category.${value}` as CampaignsMessageKey),
            }))}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field
            label={t('campaigns.templates.form.bodyEn')}
            id={`${id}-en`}
            hint={t('campaigns.templates.form.bodyHint')}
            error={errors.body === undefined ? undefined : t(errors.body)}
          >
            <textarea
              id={`${id}-en`}
              className={area}
              value={bodyEn}
              maxLength={1000}
              aria-invalid={errors.body !== undefined && bodyEn.trim() === ''}
              onChange={(event) => setBodyEn(event.target.value)}
            />
          </Field>
        </div>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
            checked={isActive}
            onChange={(event) => setIsActive(event.target.checked)}
          />
          {t('campaigns.templates.form.active')}
        </label>
        {failure === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive sm:col-span-2">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}
