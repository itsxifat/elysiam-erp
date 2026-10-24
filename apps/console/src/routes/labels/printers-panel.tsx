import type { MessageKey } from '@elysium/i18n';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Select,
  Skeleton,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Printer as PrinterIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import {
  addPrinter,
  deletePrinter,
  labelSettings,
  listPrinters,
  listTerminals,
  saveLabelSettings,
  testPrint,
  updatePrinter,
  type Printer,
  type PrinterConnection,
  type PrinterInput,
  type PrinterLanguage,
  type PrinterMedium,
  type PrintDocument,
} from './api.js';
import { PrinterStateBadge } from './parts.js';

/**
 * Labels → Printers (M46, D-810, D-814, D-815, D-817): the brand's printers by terminal, with
 * their state, a test print and, for a supervisor, adding and changing them; and the brand's
 * automatic printing rule.
 */
export function PrintersPanel() {
  const t = useT();
  const queryClient = useQueryClient();
  const printers = useQuery({
    queryKey: ['labels', 'printers'],
    queryFn: listPrinters,
    refetchInterval: 30_000,
  });
  const terminals = useQuery({ queryKey: ['terminals'], queryFn: listTerminals });
  const [editing, setEditing] = useState<Printer | 'new' | null>(null);
  const [removing, setRemoving] = useState<Printer | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const test = useMutation({
    mutationFn: testPrint,
    onSuccess: () => setNotice(t('lb.printer.testSent')),
    onError: (error) => setNotice(error instanceof ApiError ? error.message : t('lb.failed')),
  });

  if (printers.isPending || terminals.isPending) {
    return (
      <div aria-busy="true">
        <span className="sr-only">{t('lb.loading')}</span>
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (printers.isError || terminals.isError) {
    return (
      <ErrorState
        title={t('lb.failed')}
        action={
          <Button variant="outline" size="sm" onClick={() => void printers.refetch()}>
            {t('lb.retry')}
          </Button>
        }
      />
    );
  }
  const terminalName = new Map(terminals.data.terminals.map((one) => [one.id, one.name]));
  const canEdit = printers.data.canEdit;
  return (
    <div className="space-y-5">
      <AutoPrintCard />
      {canEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {terminals.data.terminals.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('lb.printers.noTerminal')}</p>
          ) : null}
          <Button
            size="sm"
            disabled={terminals.data.terminals.length === 0}
            onClick={() => setEditing('new')}
            data-testid="add-printer"
          >
            <Plus aria-hidden />
            {t('lb.printers.add')}
          </Button>
        </div>
      ) : null}
      {notice === null ? null : (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {printers.data.printers.length === 0 ? (
        <EmptyState title={t('lb.printers.empty')} detail={t('lb.printers.emptyDetail')} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm" data-testid="printers-table">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('lb.printer.name')}</th>
                <th className="px-3 py-2 font-medium">{t('lb.printer.terminal')}</th>
                <th className="px-3 py-2 font-medium">{t('lb.printer.connection')}</th>
                <th className="px-3 py-2 font-medium">{t('lb.printer.medium')}</th>
                <th className="px-3 py-2 font-medium">{t('lb.printer.documents')}</th>
                <th className="px-3 py-2 font-medium">{t('lb.col.state')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {printers.data.printers.map((printer) => (
                <tr key={printer.id} className="h-row border-b border-border last:border-b-0">
                  <td className="px-3 font-medium">
                    {printer.name}
                    {printer.host === undefined || printer.host === null ? null : (
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {`${printer.host}:${String(printer.port ?? '')}`}
                      </span>
                    )}
                  </td>
                  <td className="px-3">{terminalName.get(printer.terminalId) ?? ''}</td>
                  <td className="px-3">
                    {t(`lb.conn.${printer.connection}` as MessageKey)}
                    {printer.language === 'pdf'
                      ? ''
                      : ` · ${t(`lb.lang.${printer.language}` as MessageKey)}`}
                  </td>
                  <td className="px-3">
                    {printer.medium === 'custom'
                      ? `${String(printer.widthMm)} × ${String(printer.heightMm)} mm`
                      : t(`lb.medium.${printer.medium}` as MessageKey)}
                    {printer.language === 'pdf' ? '' : ` · ${String(printer.dpi)} dpi`}
                  </td>
                  <td className="px-3">
                    {printer.documents.map((doc) => t(`lb.doc.${doc}` as MessageKey)).join(', ')}
                  </td>
                  <td className="px-3">
                    <PrinterStateBadge state={printer.state} detail={printer.statusDetail} />
                  </td>
                  <td className="px-3 py-1 text-right">
                    {canEdit ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={test.isPending}
                          onClick={() => test.mutate(printer.id)}
                        >
                          <PrinterIcon aria-hidden />
                          {t('lb.printer.test')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(printer)}>
                          {t('lb.printer.edit')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(printer)}>
                          {t('lb.printer.delete')}
                        </Button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing === null ? null : (
        <PrinterDialog
          printer={editing === 'new' ? null : editing}
          terminals={terminals.data.terminals.map((one) => ({ value: one.id, label: one.name }))}
          credentialsKey={printers.data.credentialsKey}
          onClose={() => setEditing(null)}
        />
      )}
      {removing === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={`${t('lb.printer.delete')} · ${removing.name}`}
          description={t('lb.printer.deleteConfirm')}
          confirmLabel={t('lb.printer.delete')}
          cancelLabel={t('lb.cancel')}
          closeLabel={t('lb.close')}
          destructive
          onConfirm={async () => {
            await deletePrinter(removing.id);
            setRemoving(null);
            await queryClient.invalidateQueries({ queryKey: ['labels'] });
            await queryClient.invalidateQueries({ queryKey: ['terminals'] });
          }}
        />
      )}
    </div>
  );
}

function AutoPrintCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['labels', 'settings'], queryFn: labelSettings });
  const save = useMutation({
    mutationFn: saveLabelSettings,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['labels', 'settings'] }),
  });
  if (settings.data === undefined) return null;
  const { autoPrint, autoSlip, canEdit, autoPrintSetting } = settings.data;
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-5"
      data-testid="auto-print"
    >
      <h2 className="text-base font-semibold">{t('lb.settings.title')}</h2>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={autoPrint}
          disabled={!canEdit || save.isPending}
          onCheckedChange={(value) => save.mutate({ autoPrint: value === true, autoSlip })}
        />
        {t('lb.settings.autoPrint')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={autoSlip}
          disabled={!canEdit || !autoPrint || save.isPending}
          onCheckedChange={(value) => save.mutate({ autoPrint, autoSlip: value === true })}
        />
        {t('lb.settings.autoSlip')}
      </label>
      {autoPrintSetting === null ? (
        <p className="text-xs text-muted-foreground">{t('lb.settings.default')}</p>
      ) : null}
    </section>
  );
}

const CONNECTIONS: readonly PrinterConnection[] = ['raw', 'ipp', 'ipps', 'browser'];
const RAW_LANGUAGES: readonly PrinterLanguage[] = ['tspl', 'zpl', 'escpos'];
const MEDIA: readonly PrinterMedium[] = ['4x6', '100x150', 'a5', 'a4', 'custom'];
const DOCUMENTS: readonly PrintDocument[] = ['label', 'packing_slip'];

function PrinterDialog({
  printer,
  terminals,
  credentialsKey,
  onClose,
}: {
  readonly printer: Printer | null;
  readonly terminals: readonly { readonly value: string; readonly label: string }[];
  readonly credentialsKey: boolean;
  readonly onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    terminalId: printer?.terminalId ?? terminals[0]?.value ?? '',
    name: printer?.name ?? '',
    connection: printer?.connection ?? 'raw',
    language: printer?.language ?? 'tspl',
    host: printer?.host ?? '',
    port: printer?.port === null || printer?.port === undefined ? '' : String(printer.port),
    ippPath: printer?.ippPath ?? '/ipp/print',
    dpi: printer?.dpi === 300 ? '300' : '203',
    medium: printer?.medium ?? '4x6',
    widthMm: printer?.medium === 'custom' ? String(printer.widthMm) : '',
    heightMm: printer?.medium === 'custom' ? String(printer.heightMm) : '',
    documents: new Set<PrintDocument>(printer?.documents ?? ['label']),
    copies: String(printer?.copies ?? 1),
    username: printer?.username ?? '',
    password: '',
    enabled: printer?.enabled ?? true,
  });
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const network = form.connection !== 'browser';
  const raw = form.connection === 'raw';
  const save = useMutation({
    mutationFn: () => {
      const input: PrinterInput = {
        terminalId: form.terminalId,
        name: form.name.trim(),
        connection: form.connection,
        language: raw ? form.language : 'pdf',
        host: network ? form.host.trim() : null,
        port: network && form.port.trim() !== '' ? Number(form.port) : null,
        ippPath: form.ippPath.trim() === '' ? '/ipp/print' : form.ippPath.trim(),
        dpi: form.dpi === '300' ? 300 : 203,
        medium: form.medium,
        widthMm: form.medium === 'custom' ? Number(form.widthMm) : null,
        heightMm: form.medium === 'custom' ? Number(form.heightMm) : null,
        documents: DOCUMENTS.filter((doc) => form.documents.has(doc)),
        copies: Math.max(1, Math.min(5, Number(form.copies) || 1)),
        username:
          form.connection === 'ipp' || form.connection === 'ipps' ? form.username.trim() : '',
        ...(form.password === '' ? {} : { password: form.password }),
        enabled: form.enabled,
      };
      return printer === null ? addPrinter(input) : updatePrinter(printer.id, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['labels'] });
      await queryClient.invalidateQueries({ queryKey: ['terminals'] });
      onClose();
    },
  });
  const field = (key: string) => `${id}-${key}`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={printer === null ? t('lb.printers.add') : t('lb.printer.edit')}
      closeLabel={t('lb.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('lb.cancel')}
          </Button>
          <Button
            disabled={form.name.trim() === '' || form.documents.size === 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? t('lb.saving') : t('lb.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={field('name')}>{t('lb.printer.name')}</Label>
          <Input
            id={field('name')}
            value={form.name}
            maxLength={60}
            onChange={(event) => set('name', event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={field('terminal')}>{t('lb.printer.terminal')}</Label>
          <Select
            id={field('terminal')}
            value={form.terminalId}
            onValueChange={(value) => set('terminalId', value)}
            options={terminals}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={field('connection')}>{t('lb.printer.connection')}</Label>
          <Select
            id={field('connection')}
            value={form.connection}
            onValueChange={(value) => set('connection', value as PrinterConnection)}
            options={CONNECTIONS.map((value) => ({
              value,
              label: t(`lb.conn.${value}` as MessageKey),
            }))}
          />
        </div>
        {raw ? (
          <div className="space-y-1.5">
            <Label htmlFor={field('language')}>{t('lb.printer.language')}</Label>
            <Select
              id={field('language')}
              value={form.language}
              onValueChange={(value) => set('language', value as PrinterLanguage)}
              options={RAW_LANGUAGES.map((value) => ({
                value,
                label: t(`lb.lang.${value}` as MessageKey),
              }))}
            />
          </div>
        ) : null}
        {network ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={field('host')}>{t('lb.printer.host')}</Label>
              <Input
                id={field('host')}
                value={form.host}
                inputMode="decimal"
                placeholder="192.168.20.50"
                aria-describedby={field('host-hint')}
                onChange={(event) => set('host', event.target.value)}
              />
              <p id={field('host-hint')} className="text-xs text-muted-foreground">
                {t('lb.printer.hostHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={field('port')}>{t('lb.printer.port')}</Label>
              <Input
                id={field('port')}
                value={form.port}
                inputMode="numeric"
                placeholder={raw ? '9100' : '631'}
                onChange={(event) => set('port', event.target.value)}
              />
            </div>
          </>
        ) : null}
        {form.connection === 'ipp' || form.connection === 'ipps' ? (
          <div className="space-y-1.5">
            <Label htmlFor={field('path')}>{t('lb.printer.path')}</Label>
            <Input
              id={field('path')}
              value={form.ippPath}
              onChange={(event) => set('ippPath', event.target.value)}
            />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor={field('medium')}>{t('lb.printer.medium')}</Label>
          <Select
            id={field('medium')}
            value={form.medium}
            onValueChange={(value) => set('medium', value as PrinterMedium)}
            options={MEDIA.map((value) => ({
              value,
              label: t(`lb.medium.${value}` as MessageKey),
            }))}
          />
        </div>
        {form.medium === 'custom' ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={field('width')}>{t('lb.printer.width')}</Label>
              <Input
                id={field('width')}
                value={form.widthMm}
                inputMode="decimal"
                onChange={(event) => set('widthMm', event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={field('height')}>{t('lb.printer.height')}</Label>
              <Input
                id={field('height')}
                value={form.heightMm}
                inputMode="decimal"
                onChange={(event) => set('heightMm', event.target.value)}
              />
            </div>
          </>
        ) : null}
        {raw ? (
          <div className="space-y-1.5">
            <Label htmlFor={field('dpi')}>{t('lb.printer.dpi')}</Label>
            <Select
              id={field('dpi')}
              value={form.dpi}
              onValueChange={(value) => set('dpi', value)}
              options={[
                { value: '203', label: '203' },
                { value: '300', label: '300' },
              ]}
            />
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label htmlFor={field('copies')}>{t('lb.printer.copies')}</Label>
          <Input
            id={field('copies')}
            value={form.copies}
            inputMode="numeric"
            onChange={(event) => set('copies', event.target.value)}
          />
        </div>
        {form.connection === 'ipps' ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor={field('username')}>{t('lb.printer.username')}</Label>
              <Input
                id={field('username')}
                value={form.username}
                autoComplete="off"
                onChange={(event) => set('username', event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={field('password')}>{t('lb.printer.password')}</Label>
              <Input
                id={field('password')}
                type="password"
                value={form.password}
                autoComplete="new-password"
                disabled={!credentialsKey}
                onChange={(event) => set('password', event.target.value)}
              />
              {printer?.passwordSet === true ? (
                <p className="text-xs text-muted-foreground">
                  {`${t('lb.printer.passwordSet')}. ${t('lb.printer.passwordKeep')}`}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
      <fieldset className="mt-4 space-y-2">
        <legend className="text-sm font-medium">{t('lb.printer.documents')}</legend>
        {DOCUMENTS.map((doc) => (
          <label key={doc} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.documents.has(doc)}
              onCheckedChange={() =>
                setForm((current) => {
                  const next = new Set(current.documents);
                  if (next.has(doc)) next.delete(doc);
                  else next.add(doc);
                  return { ...current, documents: next };
                })
              }
            />
            {t(`lb.doc.${doc}` as MessageKey)}
          </label>
        ))}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.enabled}
            onCheckedChange={(value) => set('enabled', value === true)}
          />
          {t('lb.printer.enabled')}
        </label>
      </fieldset>
      {save.error === null ? null : (
        <p role="alert" className="mt-3 text-sm text-destructive-text">
          {save.error instanceof ApiError ? save.error.message : t('lb.failed')}
        </p>
      )}
    </Dialog>
  );
}
