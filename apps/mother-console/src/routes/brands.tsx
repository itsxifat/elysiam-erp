import {
  Button,
  Checkbox,
  DateTime,
  Dialog,
  EmptyState,
  ErrorState,
  Label,
  PageHeader,
  Section,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import {
  brandUpdateSchema,
  type BrandStatusWire,
  type ConnectionTestWire,
} from '@elysium/mother-shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, KeyRound, Plug, RefreshCw, Server } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import { endpoints } from '../api.js';
import { useLocale, type MessageKey } from '../i18n/locale.js';
import { brandsQueryKey } from '../shell/shell.js';
import { BrandFreshness, brandErrorKey } from '../ui/brand-status.js';
import { count } from '../ui/format.js';
import { Alert, Field, Notice } from '../ui/primitives.js';

/**
 * The brand registry (M32 screen 5; D-481, D-490, D-700): the brands this console reads,
 * how fresh each one's figures are, a test of its connection and a read on demand.
 *
 * A brand is added, its read connection changed and its owner sign-in key made or
 * replaced only on the mother's server, by the operator's `brands` commands, so no
 * database password is ever typed into a browser. The screen says so in plain words and
 * offers only what an owner may change here: the name, the staff console's address and
 * whether the brand is read.
 */

type FieldName = 'displayName' | 'adminUrl';

const FIELD_ERROR: Readonly<Record<FieldName, MessageKey>> = {
  displayName: 'form.required',
  adminUrl: 'form.urlInvalid',
};

function fieldErrors(issues: readonly { readonly path: readonly PropertyKey[] }[]) {
  const found = new Set<FieldName>();
  for (const issue of issues) {
    const name = issue.path[0];
    if (name === 'displayName' || name === 'adminUrl') found.add(name);
  }
  return found;
}

export function BrandsPage() {
  const { t } = useLocale();
  const brands = useQuery({ queryKey: brandsQueryKey(), queryFn: endpoints.brands });

  return (
    <div className="space-y-6">
      <PageHeader title={t('brands.title')} description={t('brands.description')} />
      <OnTheServer />
      {brands.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : brands.isError ? (
        <ErrorState title={t('common.error')} detail={t('common.errorDetail')} />
      ) : brands.data.brands.length === 0 ? (
        <EmptyState icon={Building2} title={t('brands.empty')} detail={t('brands.emptyDetail')} />
      ) : (
        <div className="space-y-4">
          {brands.data.brands.map((brand) => (
            <BrandCard key={brand.id} brand={brand} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Where brands come from, in plain words (D-700). */
export function OnTheServer() {
  const { t } = useLocale();
  return (
    <section
      aria-labelledby="brands-on-server"
      className="flex items-start gap-3 rounded-lg border border-border bg-muted px-4 py-3"
    >
      <Server aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-1 text-sm">
        <h2 id="brands-on-server" className="font-medium text-foreground">
          {t('brands.onServer.title')}
        </h2>
        <p className="text-muted-foreground">{t('brands.onServer.body')}</p>
      </div>
    </section>
  );
}

function BrandCard({ brand }: { readonly brand: BrandStatusWire }) {
  const { t, locale } = useLocale();
  const [editing, setEditing] = useState(false);
  const [tested, setTested] = useState<ConnectionTestWire | null>(null);
  const [queued, setQueued] = useState(false);

  const test = useMutation({
    mutationFn: () => endpoints.testBrand(brand.id),
    onSuccess: (result) => setTested(result),
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
        <span className="text-xs text-muted-foreground">{t('brands.keyOnServer')}</span>
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

      <BrandForm
        open={editing}
        onOpenChange={setEditing}
        brand={brand}
        onSaved={() => setEditing(false)}
      />
    </Section>
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
  readonly brand: BrandStatusWire;
  readonly onSaved: () => void;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const activeId = useId();
  const [displayName, setDisplayName] = useState(brand.displayName);
  const [adminUrl, setAdminUrl] = useState(brand.adminUrl);
  const [isActive, setIsActive] = useState(brand.isActive);
  const [invalid, setInvalid] = useState<ReadonlySet<FieldName>>(new Set());
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = brandUpdateSchema.safeParse({ displayName, adminUrl, isActive });
    if (!parsed.success) {
      setInvalid(fieldErrors(parsed.error.issues));
      setError('form.invalid');
      return;
    }
    setInvalid(new Set());
    setBusy(true);
    try {
      await endpoints.updateBrand(brand.id, parsed.data);
      await queryClient.invalidateQueries({ queryKey: brandsQueryKey() });
      onSaved();
    } catch {
      setError('common.errorDetail');
    } finally {
      setBusy(false);
    }
  }

  const fieldError = (name: FieldName) => (invalid.has(name) ? t(FIELD_ERROR[name]) : undefined);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={brand.displayName}
      description={t('brands.editDescription')}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(event) => void submit(event)} className="space-y-4" noValidate>
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
        <div className="flex items-center gap-2">
          <Checkbox
            id={activeId}
            checked={isActive}
            onCheckedChange={(checked) => setIsActive(checked === true)}
          />
          <Label htmlFor={activeId}>{t('brands.active')}</Label>
        </div>
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
