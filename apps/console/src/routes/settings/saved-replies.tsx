import { Button, ConfirmDialog, Input, Label, Skeleton, cn, controlClassName } from '@elysium/ui';
import { SAVED_REPLY_PLACEHOLDERS } from '@elysium/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';

import '../../alive/alive.css';
import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  createSavedReply,
  deleteSavedReply,
  listSavedReplies,
  SAVED_REPLIES_KEY,
  updateSavedReply,
  type SavedReply,
  type SavedReplyBody,
} from '../inbox/api.js';
import { useInboxT } from '../inbox/messages.js';
import { hasBangla } from '../inbox/thread-logic.js';

/**
 * Settings → Inbox → Saved replies (M44a, D-763): the brand's shared answers. Everyone in the
 * inbox reads them (`read SavedReply`) and drops them into a reply with `/`; the inbox's
 * supervisor writes and removes them (`create`, `update`, `delete SavedReply`: org_admin). A body
 * may be in any language, Bangla included, and may name the four placeholders, inserted here
 * at the caret with one click.
 */
export function SavedRepliesSettings() {
  const t = useInboxT();
  const ability = useAbility();
  const query = useQuery({ queryKey: SAVED_REPLIES_KEY, queryFn: listSavedReplies });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const mayCreate = ability.can('create', 'SavedReply');
  const mayEdit = ability.can('update', 'SavedReply');
  const mayDelete = ability.can('delete', 'SavedReply');

  return (
    <section id="saved-replies" aria-labelledby="saved-replies-title" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="saved-replies-title" className="text-sm font-semibold">
          {t('inbox.saved.settingsTitle')}
        </h2>
        {mayCreate && !adding ? (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAdding(true)}>
            <Plus aria-hidden="true" />
            {t('inbox.saved.add')}
          </Button>
        ) : null}
      </div>
      <p className="max-w-3xl text-sm text-muted-foreground">{t('inbox.saved.settingsDetail')}</p>
      {mayCreate || mayEdit ? null : (
        <p className="text-sm text-muted-foreground">{t('inbox.saved.readOnly')}</p>
      )}
      {adding ? <ReplyForm onDone={() => setAdding(false)} /> : null}
      {query.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label={t('inbox.loading')}>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive-text">
          {query.error instanceof ApiError ? query.error.message : t('inbox.errorDetail')}
        </p>
      ) : query.data.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('inbox.saved.none')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {query.data.items.map((reply) =>
            editing === reply.id ? (
              <li key={reply.id} className="p-3">
                <ReplyForm reply={reply} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <ReplyRow
                key={reply.id}
                reply={reply}
                mayEdit={mayEdit}
                mayDelete={mayDelete}
                onEdit={() => setEditing(reply.id)}
              />
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function ReplyRow({
  reply,
  mayEdit,
  mayDelete,
  onEdit,
}: {
  readonly reply: SavedReply;
  readonly mayEdit: boolean;
  readonly mayDelete: boolean;
  readonly onEdit: () => void;
}) {
  const t = useInboxT();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-start gap-3 p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-xs text-primary">/{reply.shortcut}</span>
          <span className="text-sm font-medium">{reply.title}</span>
          {reply.category === null ? null : (
            <span className="text-xs text-muted-foreground">{reply.category}</span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('inbox.saved.uses', { n: String(reply.usageCount) })}
          </span>
        </p>
        <p
          lang={hasBangla(reply.body) ? 'bn' : undefined}
          className="text-sm break-words whitespace-pre-wrap text-muted-foreground"
        >
          {reply.body}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        {mayEdit ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${t('inbox.saved.edit')} /${reply.shortcut}`}
            onClick={onEdit}
          >
            <Pencil aria-hidden="true" />
          </Button>
        ) : null}
        {mayDelete ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${t('inbox.saved.delete')} /${reply.shortcut}`}
            onClick={() => setConfirming(true)}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('inbox.saved.deleteTitle', { shortcut: reply.shortcut })}
        description={t('inbox.saved.deleteDetail')}
        confirmLabel={t('inbox.saved.delete')}
        cancelLabel={t('inbox.cancel')}
        closeLabel={t('inbox.cancel')}
        destructive
        onConfirm={async () => {
          await deleteSavedReply(reply.id);
          await queryClient.invalidateQueries({ queryKey: SAVED_REPLIES_KEY });
        }}
      />
    </li>
  );
}

function ReplyForm({
  reply,
  onDone,
}: {
  readonly reply?: SavedReply;
  readonly onDone: () => void;
}) {
  const t = useInboxT();
  const ids = useId();
  const queryClient = useQueryClient();
  const body = useRef<HTMLTextAreaElement>(null);
  const [values, setValues] = useState<SavedReplyBody>({
    title: reply?.title ?? '',
    shortcut: reply?.shortcut ?? '',
    body: reply?.body ?? '',
    category: reply?.category ?? '',
  });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const input: SavedReplyBody = {
        title: values.title.trim(),
        shortcut: values.shortcut.trim().toLowerCase(),
        body: values.body.trim(),
        ...(values.category?.trim() ? { category: values.category.trim() } : {}),
      };
      return reply === undefined ? createSavedReply(input) : updateSavedReply(reply.id, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: SAVED_REPLIES_KEY });
      onDone();
    },
    onError: (cause) =>
      setProblem(
        cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause),
      ),
  });

  const set = (field: keyof SavedReplyBody) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  /** Put a placeholder at the caret, and the caret after it. */
  const place = (name: string) => {
    const element = body.current;
    const token = `{${name}}`;
    const start = element?.selectionStart ?? values.body.length;
    const end = element?.selectionEnd ?? values.body.length;
    const next = `${values.body.slice(0, start)}${token}${values.body.slice(end)}`;
    set('body')(next);
    window.requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    save.mutate();
  };

  return (
    <form
      onSubmit={submit}
      aria-label={
        reply === undefined ? t('inbox.saved.add') : `${t('inbox.saved.edit')} /${reply.shortcut}`
      }
      className="alive-in space-y-3 rounded-lg border border-border p-3"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${ids}-title`}>{t('inbox.saved.title')}</Label>
          <Input
            id={`${ids}-title`}
            value={values.title}
            maxLength={80}
            required
            onChange={(event) => set('title')(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-shortcut`}>{t('inbox.saved.shortcut')}</Label>
          <Input
            id={`${ids}-shortcut`}
            value={values.shortcut}
            maxLength={32}
            required
            pattern="[a-zA-Z0-9][a-zA-Z0-9_\-]{0,31}"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={`${ids}-shortcut-hint`}
            onChange={(event) => set('shortcut')(event.target.value.replace(/\s+/g, '-'))}
          />
          <p id={`${ids}-shortcut-hint`} className="text-xs text-muted-foreground">
            {t('inbox.saved.shortcutHint')}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${ids}-category`}>{t('inbox.saved.category')}</Label>
          <Input
            id={`${ids}-category`}
            value={values.category ?? ''}
            maxLength={40}
            onChange={(event) => set('category')(event.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${ids}-body`}>{t('inbox.saved.body')}</Label>
        <textarea
          ref={body}
          id={`${ids}-body`}
          value={values.body}
          maxLength={1000}
          required
          rows={4}
          lang={hasBangla(values.body) ? 'bn' : undefined}
          onChange={(event) => set('body')(event.target.value)}
          className={cn(controlClassName, 'h-auto w-full py-2')}
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {SAVED_REPLY_PLACEHOLDERS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => place(name)}
              className="rounded-full border border-border px-2 py-0.5 font-mono text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {`{${name}}`}
            </button>
          ))}
        </div>
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? t('inbox.saving') : t('inbox.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t('inbox.cancel')}
        </Button>
      </div>
    </form>
  );
}
