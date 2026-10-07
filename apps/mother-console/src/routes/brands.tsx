import {
  Button,
  ConfirmDialog,
  DateTime,
  Dialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Section,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import {
  brandCreateSchema,
  brandUpdateSchema,
  type BrandStatusWire,
  type ConnectionTestWire,
  type OwnerLinkKeyWire,
} from '@elysium/mother-shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, Copy, KeyRound, Plug, Plus, RefreshCw } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { ApiError, endpoints } from '../api.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';
import { brandsQueryKey } from '../shell/shell.js';
import { BrandFreshness, brandErrorKey } from '../ui/brand-status.js';
import { count } from '../ui/format.js';
import { Alert, Field, Notice } from '../ui/primitives.js';

/**
 * The brand registry (M32 screen 5; D-481, D-490): add a brand, change it, test its read
 * connection, and make or replace the key that signs owner links. A connection string is
 * typed in and never shown again (only its fingerprint); a public key is shown once.
 */

type FieldName = 'slug' | 'displayName' | 'adminUrl' | 'readConnection';

const FIELD_ERROR: Readonly<Record<FieldName, MessageKey>> = {
  slug: 'form.slugInvalid',
  displayName: 'form.required',
  adminUrl: 'form.urlInvalid',
  readConnection: 'form.connectionInvalid',
};

function fieldErrors(issues: readonly { readonly path: readonly PropertyKey[] }[]) {
  const found = new Set<FieldName>();
  for (const issue of issues) {
    const name = issue.path[0];
    if (
      name === 'slug' ||
      name === 'displayName' ||
      name === 'adminUrl' ||
      name === 'readConnection'
    ) {
      found.add(name);
    }
  }
  return found;
}

export function BrandsPage() {
  const { t } = useLocale();
  const brands = useQuery({ queryKey: brandsQueryKey(), queryFn: endpoints.brands });
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState(false);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('brands.title')}
        description={t('brands.description')}
        actions={
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {t('brands.add')}
          </Button>
        }
      />
      {created ? <Notice>{t('brands.created')}</Notice> : null}
      {brands.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : brands.isError ? (
        <ErrorState title={t('common.error')} detail={t('common.errorDetail')} />
      ) : brands.data.brands.length === 0 ? (
        <EmptyState icon={Building2} title={t('brands.empty')} />
      ) : (
        <div className="space-y-4">
          {brands.data.brands.map((brand) => (
            <BrandCard key={brand.id} brand={brand} />
          ))}
        </div>
      )}
      <BrandForm
        open={adding}
        onOpenChange={setAdding}
        onSaved={() => {
          setAdding(false);
          setCreated(true);
        }}
      />
    </div>
  );
}

function BrandCard({ brand }: { readonly brand: BrandStatusWire }) {
  const { t, locale } = useLocale();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirmKey, setConfirmKey] = useState(false);
  const [shownKey, setShownKey] = useState<OwnerLinkKeyWire | null>(null);
  const [tested, setTested] = useState<ConnectionTestWire | null>(null);
  const [queued, setQueued] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: brandsQueryKey() });

  const test = useMutation({
    mutationFn: () => endpoints.testBrand(brand.id),
    onSuccess: (result) => setTested(result),
  });
  const rotate = useMutation({
    mutationFn: () => endpoints.rotateKey(brand.id),
    onSuccess: async (result) => {
      setShownKey(result);
      await refresh();
    },
  });
  const pull = useMutation({
    mutationFn: (full: boolean) => endpoints.pull(brand.id, full),
    onSuccess: () => setQueued(true),
  });

  return (
    <Section
      title={brand.displayName}
      description={brand.slug}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {t('brands.edit')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            <Plug aria-hidden="true" />
            {test.isPending ? t('brands.testing') : t('brands.test')}
          </Button>
        </>
      }
    >
      <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">{t('brands.adminUrl')}</dt>
          <dd className="mt-1 break-all">{brand.adminUrl}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('brands.connection')}</dt>
          <dd className="mt-1 font-mono text-xs">
            {t('brands.fingerprint')} {brand.connectionFingerprint}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('brands.lastRead')}</dt>
          <dd className="mt-1">
            <BrandFreshness brand={brand} />
            {brand.lastAttemptAt === null ? null : (
              <span className="block text-xs text-muted-foreground">
                <DateTime value={brand.lastAttemptAt} compact />
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('brands.version')}</dt>
          <dd className="mt-1 tabular-nums">
            {brand.brandMigrations === null ? '—' : count(brand.brandMigrations, locale)} /{' '}
            {count(brand.expectedMigrations, locale)}{' '}
            {brand.schema === 'version_mismatch' ? (
              <StatusBadge tone="warning">{t('status.versionMismatch')}</StatusBadge>
            ) : null}
          </dd>
        </div>
      </dl>

      {brand.lastError === null ? null : (
        <p className="mt-4 text-sm text-muted-foreground">
          {t(brandErrorKey(brand.lastError.code))}
        </p>
      )}
      {tested === null ? null : tested.ok ? (
        <Notice className="mt-4">{t('brandError.ok')}</Notice>
      ) : (
        <Alert className="mt-4">{t(brandErrorKey(tested.code))}</Alert>
      )}
      {test.isError ? <Alert className="mt-4">{t('common.errorDetail')}</Alert> : null}

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <KeyRound aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-sm">
          {t('brands.key')}:{' '}
          {brand.ownerLinkKeyFingerprint === null ? (
            <span className="text-muted-foreground">{t('brands.keyNone')}</span>
          ) : (
            <span className="font-mono text-xs">{brand.ownerLinkKeyFingerprint}</span>
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={rotate.isPending}
          onClick={() => (brand.hasOwnerLinkKey ? setConfirmKey(true) : rotate.mutate())}
        >
          {brand.hasOwnerLinkKey ? t('brands.keyRotate') : t('brands.keyMake')}
        </Button>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          disabled={pull.isPending}
          onClick={() => pull.mutate(false)}
        >
          <RefreshCw aria-hidden="true" />
          {t('brand.pullNow')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={pull.isPending}
          onClick={() => pull.mutate(true)}
        >
          {t('brands.readFull')}
        </Button>
      </div>
      {queued ? <Notice className="mt-3">{t('brand.pullQueued')}</Notice> : null}

      <ConfirmDialog
        open={confirmKey}
        onOpenChange={setConfirmKey}
        title={t('brands.keyRotate')}
        description={t('brands.keyConfirmRotate')}
        confirmLabel={t('brands.keyRotate')}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        destructive
        onConfirm={async () => {
          await rotate.mutateAsync();
          setConfirmKey(false);
        }}
      />
      <KeyDialog shown={shownKey} onClose={() => setShownKey(null)} />
      <BrandForm
        open={editing}
        onOpenChange={setEditing}
        brand={brand}
        onSaved={() => setEditing(false)}
      />
    </Section>
  );
}

function KeyDialog({
  shown,
  onClose,
}: {
  readonly shown: OwnerLinkKeyWire | null;
  readonly onClose: () => void;
}) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  return (
    <Dialog
      open={shown !== null}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
      title={t('brands.key')}
      description={t('brands.keyShownOnce')}
      closeLabel={t('common.close')}
      footer={
        <Button
          onClick={() => {
            if (shown === null) return;
            void navigator.clipboard.writeText(shown.envLine).then(() => setCopied(true));
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      }
    >
      {shown === null ? null : (
        <div className="space-y-3">
          <code className="block rounded-md bg-muted p-3 font-mono text-xs break-all text-foreground">
            {shown.envLine}
          </code>
          <p className="text-xs text-muted-foreground">
            {t('brands.fingerprint')} <span className="font-mono">{shown.fingerprint}</span>
          </p>
        </div>
      )}
    </Dialog>
  );
}

function BrandForm({
  open,
  onOpenChange,
  brand,
  onSaved,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly brand?: BrandStatusWire;
  readonly onSaved: () => void;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState(brand?.slug ?? '');
  const [displayName, setDisplayName] = useState(brand?.displayName ?? '');
  const [adminUrl, setAdminUrl] = useState(brand?.adminUrl ?? '');
  const [readConnection, setReadConnection] = useState('');
  const [isActive, setIsActive] = useState(brand?.isActive ?? true);
  const [invalid, setInvalid] = useState<ReadonlySet<FieldName>>(new Set());
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (brand === undefined) {
        const parsed = brandCreateSchema.safeParse({ slug, displayName, adminUrl, readConnection });
        if (!parsed.success) {
          setInvalid(fieldErrors(parsed.error.issues));
          setError('form.invalid');
          return;
        }
        setInvalid(new Set());
        setBusy(true);
        await endpoints.addBrand(parsed.data);
      } else {
        const parsed = brandUpdateSchema.safeParse({
          displayName,
          adminUrl,
          isActive,
          ...(readConnection.trim() === '' ? {} : { readConnection }),
        });
        if (!parsed.success) {
          setInvalid(fieldErrors(parsed.error.issues));
          setError('form.invalid');
          return;
        }
        setInvalid(new Set());
        setBusy(true);
        await endpoints.updateBrand(brand.id, parsed.data);
      }
      setReadConnection('');
      await queryClient.invalidateQueries({ queryKey: brandsQueryKey() });
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.code === 'BRAND_SLUG_TAKEN'
          ? 'brands.slugTaken'
          : 'common.errorDetail',
      );
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (name: FieldName) => (invalid.has(name) ? t(FIELD_ERROR[name]) : undefined);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={brand === undefined ? t('brands.add') : brand.displayName}
      description={t('brands.description')}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
        {brand === undefined ? (
          <Field
            label={t('brands.slug')}
            hint={t('brands.slugHint')}
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            error={fieldError('slug')}
            autoComplete="off"
            spellCheck={false}
          />
        ) : null}
        <Field
          label={t('brands.displayName')}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          error={fieldError('displayName')}
        />
        <Field
          label={t('brands.adminUrl')}
          hint={t('brands.adminUrlHint')}
          type="url"
          value={adminUrl}
          onChange={(event) => setAdminUrl(event.target.value)}
          error={fieldError('adminUrl')}
          spellCheck={false}
        />
        <Field
          label={t('brands.readConnection')}
          hint={
            brand === undefined ? t('brands.readConnectionHint') : t('brands.readConnectionKeep')
          }
          type="password"
          autoComplete="off"
          value={readConnection}
          onChange={(event) => setReadConnection(event.target.value)}
          error={fieldError('readConnection')}
          spellCheck={false}
        />
        {brand === undefined ? null : (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              className="size-4 rounded-sm border-input accent-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            />
            {t('brands.active')}
          </label>
        )}
        {error === null ? null : <Alert>{t(error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t('brands.saving') : t('brands.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
