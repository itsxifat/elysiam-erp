import { Button, cn } from '@elysium/ui';
import {
  fillSavedReply,
  insertAtSlash,
  matchSavedReplies,
  quickReplies,
  slashQueryAt,
} from '@elysium/domain/inbox';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Send, Zap } from 'lucide-react';
import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
} from 'react';

import '../../alive/alive.css';
import { playTone } from '../../alive/tones.js';
import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  countSavedReplyUse,
  getPanel,
  INBOX_KEY,
  listSavedReplies,
  SAVED_REPLIES_KEY,
  type ConversationItem,
  type SavedReply,
} from './api.js';
import { useComposerFill } from './composer-bridge.js';
import { readDraft, writeDraft } from './drafts.js';
import { useInboxT } from './messages.js';
import { hasBangla, placeholderValues, utf8Length } from './thread-logic.js';

/** The reply's limit (`inboxReplySchema`); Instagram's is 1,000 bytes (D-731). */
const MAX_CHARS = 1000;
const MAX_INSTAGRAM_BYTES = 1000;

export interface ComposerProps {
  readonly conversation: ConversationItem;
  /** Outside the 24-hour window, or no right to write: the box is shown but takes nothing. */
  readonly disabled: boolean;
  /**
   * Send the words. `sent` is called once they are on their way (the owner may first be asked,
   * D-737), and only then is the draft cleared.
   */
  readonly onSend: (text: string, sent: () => void) => Promise<void>;
  /** M45 (voice messages): the record button, and anything else that sits beside Send. */
  readonly actions?: ReactNode;
  /** Described by: the hint under the box. */
  readonly describedBy?: string;
}

/**
 * The reply box (M42, M44a: D-763, D-767). Enter sends, Shift+Enter breaks the line, Bangla
 * typed with the system's keyboard is taken as it is (an input method's Enter never sends).
 *
 * Typing `/` opens the saved replies, filtered as you type: arrows move, Enter or Tab inserts,
 * Escape closes. Inserting fills `{name}`, `{order_number}`, `{total}` and `{phone}` from the
 * conversation and its customer and counts the use; a placeholder with nothing to fill it stays
 * selected so it is typed over. The five most used sit above the box as quick replies.
 */
export function Composer({ conversation, disabled, onSend, actions, describedBy }: ComposerProps) {
  const t = useInboxT();
  const ids = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => readDraft(conversation.id));
  const [picker, setPicker] = useState<{
    readonly start: number;
    readonly query: string;
    readonly index: number;
  } | null>(null);
  const [missing, setMissing] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const mayUseSaved = ability.can('read', 'SavedReply');
  const saved = useQuery({
    queryKey: SAVED_REPLIES_KEY,
    queryFn: listSavedReplies,
    staleTime: 60_000,
    enabled: mayUseSaved,
  });
  const panel = useQuery({
    queryKey: [...INBOX_KEY, 'panel', conversation.id],
    queryFn: () => getPanel(conversation.id),
    enabled: mayUseSaved,
  });
  const replies = saved.data?.items ?? [];
  const matches = picker === null ? [] : matchSavedReplies(replies, picker.query);
  const quick = disabled ? [] : quickReplies(replies);

  const send = useMutation({
    mutationFn: async () => {
      const words = text.trim();
      if (words === '') return;
      setProblem(null);
      await onSend(words, () => {
        setText('');
        writeDraft(conversation.id, '');
        setMissing([]);
        playTone('sent');
      });
    },
    onError: (cause) => {
      playTone('error');
      setProblem(
        cause instanceof ApiError || cause instanceof Error ? cause.message : String(cause),
      );
    },
  });

  const update = (next: string) => {
    setText(next);
    writeDraft(conversation.id, next);
  };

  // M44b (D-775): the panel's order summary lands here, after anything already typed.
  useComposerFill(conversation.id, (summary) => {
    if (disabled) return false;
    const next = text.trim() === '' ? summary : `${text.trimEnd()}\n${summary}`;
    update(next);
    setPicker(null);
    window.requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(next.length, next.length);
    });
    return true;
  });

  /** The `/` token at the caret opens, moves or closes the picker. */
  const follow = (value: string, caret: number) => {
    const token = mayUseSaved ? slashQueryAt(value, caret) : null;
    setPicker((current) =>
      token === null
        ? null
        : {
            start: token.start,
            query: token.query,
            index: current?.query === token.query ? current.index : 0,
          },
    );
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    update(event.target.value);
    follow(event.target.value, event.target.selectionStart);
    if (missing.length > 0) setMissing([]);
  };

  const onSelect = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    if (target.selectionStart !== target.selectionEnd) return;
    follow(target.value, target.selectionStart);
  };

  /** Put a saved reply in: over the `/query` being typed, or at the caret from a quick reply. */
  const insert = (reply: SavedReply, from: { readonly start: number; readonly end: number }) => {
    const filled = fillSavedReply(reply.body, placeholderValues(conversation, panel.data));
    const next = insertAtSlash(text, from.start, from.end, filled.text);
    update(next.text);
    setPicker(null);
    setMissing(filled.missing);
    void countSavedReplyUse(reply.id)
      .then(() => queryClient.invalidateQueries({ queryKey: SAVED_REPLIES_KEY }))
      .catch(() => undefined);
    const firstGap =
      filled.missing[0] === undefined
        ? -1
        : next.text.indexOf(`{${filled.missing[0]}}`, from.start);
    window.requestAnimationFrame(() => {
      const element = box.current;
      if (element === null) return;
      element.focus();
      if (firstGap >= 0 && filled.missing[0] !== undefined) {
        element.setSelectionRange(firstGap, firstGap + filled.missing[0].length + 2);
      } else {
        element.setSelectionRange(next.caret, next.caret);
      }
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (picker !== null) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPicker(null);
        return;
      }
      if (matches.length > 0) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : -1;
          setPicker({
            ...picker,
            index: (picker.index + step + matches.length) % matches.length,
          });
          return;
        }
        if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
          event.preventDefault();
          const chosen = matches[Math.min(picker.index, matches.length - 1)];
          if (chosen !== undefined) {
            insert(chosen, { start: picker.start, end: event.currentTarget.selectionStart });
          }
          return;
        }
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (!send.isPending && !disabled) send.mutate();
    }
  };

  const listbox = `${ids}-saved`;
  const optionId = (index: number) => `${ids}-saved-${String(index)}`;
  const active =
    picker === null || matches.length === 0 ? null : Math.min(picker.index, matches.length - 1);

  const chars = text.length;
  const bytes = conversation.channel === 'instagram' ? utf8Length(text) : null;
  const showCount =
    chars > MAX_CHARS * 0.8 || (bytes !== null && bytes > MAX_INSTAGRAM_BYTES * 0.8);
  const over = chars > MAX_CHARS || (bytes !== null && bytes > MAX_INSTAGRAM_BYTES);

  return (
    <div className="space-y-2">
      {quick.length === 0 ? null : (
        <div
          role="group"
          aria-label={t('inbox.saved.quick')}
          className="flex flex-wrap items-center gap-1.5"
        >
          <Zap aria-hidden="true" className="size-3.5 text-muted-foreground" />
          {quick.map((reply) => (
            <button
              key={reply.id}
              type="button"
              title={reply.body}
              onClick={() => {
                const element = box.current;
                const start = element?.selectionStart ?? text.length;
                const end = element?.selectionEnd ?? text.length;
                insert(reply, { start, end });
              }}
              className={cn(
                'alive-press max-w-48 truncate rounded-full border border-border bg-background px-2.5 py-0.5 text-xs',
                'motion-safe:duration-fast hover:bg-accent motion-safe:transition-colors',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              )}
            >
              {reply.title}
            </button>
          ))}
        </div>
      )}

      <form
        className="relative flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!send.isPending) send.mutate();
        }}
      >
        {picker === null ? null : (
          <SavedReplyPicker
            id={listbox}
            optionId={optionId}
            matches={matches}
            active={active}
            query={picker.query}
            empty={replies.length === 0}
            mayManage={ability.can('update', 'SavedReply')}
            onPick={(reply) =>
              insert(reply, {
                start: picker.start,
                end: box.current?.selectionStart ?? text.length,
              })
            }
          />
        )}
        <label htmlFor={`${ids}-compose`} className="sr-only">
          {t('inbox.thread.compose')}
        </label>
        <textarea
          ref={box}
          id={`${ids}-compose`}
          data-inbox-composer=""
          value={text}
          onChange={onChange}
          onSelect={onSelect}
          onKeyDown={onKeyDown}
          onBlur={() => setPicker(null)}
          rows={2}
          maxLength={MAX_CHARS * 2}
          disabled={disabled}
          lang={hasBangla(text) ? 'bn' : undefined}
          placeholder={t('inbox.thread.composePlaceholder')}
          aria-describedby={describedBy}
          aria-autocomplete={mayUseSaved ? 'list' : undefined}
          aria-controls={picker === null ? undefined : listbox}
          aria-activedescendant={active === null ? undefined : optionId(active)}
          className={cn(
            'flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm',
            'motion-safe:duration-fast motion-safe:transition-colors',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50',
            over && 'border-destructive',
          )}
        />
        {actions}
        <Button
          type="submit"
          className="alive-press"
          disabled={disabled || send.isPending || text.trim() === '' || over}
        >
          <Send aria-hidden className="size-4" />
          {t('inbox.thread.send')}
        </Button>
      </form>

      {showCount ? (
        <p
          aria-live="polite"
          className={cn(
            'text-xs tabular-nums',
            over ? 'text-destructive-text' : 'text-muted-foreground',
          )}
        >
          {bytes !== null && bytes > MAX_INSTAGRAM_BYTES * 0.8
            ? t('inbox.compose.countBytes', {
                used: String(bytes),
                max: String(MAX_INSTAGRAM_BYTES),
              })
            : t('inbox.compose.count', { used: String(chars), max: String(MAX_CHARS) })}
        </p>
      ) : null}
      {missing.length === 0 ? null : (
        <p role="status" className="text-xs text-warning-subtle-foreground">
          {t('inbox.saved.missing', { names: missing.map((name) => `{${name}}`).join(', ') })}
        </p>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {problem}
        </p>
      )}
    </div>
  );
}

function SavedReplyPicker({
  id,
  optionId,
  matches,
  active,
  query,
  empty,
  mayManage,
  onPick,
}: {
  readonly id: string;
  readonly optionId: (index: number) => string;
  readonly matches: readonly SavedReply[];
  readonly active: number | null;
  readonly query: string;
  readonly empty: boolean;
  readonly mayManage: boolean;
  readonly onPick: (reply: SavedReply) => void;
}) {
  const t = useInboxT();
  return (
    <div className="alive-in absolute right-0 bottom-full left-0 z-20 mb-2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-popover">
      <p className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {t('inbox.saved.label')}
      </p>
      {matches.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">
          {empty ? t('inbox.saved.none') : t('inbox.saved.noMatch', { query })}
        </p>
      ) : (
        <ul
          id={id}
          role="listbox"
          aria-label={t('inbox.saved.label')}
          className="max-h-64 overflow-y-auto py-1"
        >
          {matches.map((reply, index) => (
            <li
              key={reply.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              // Keep the box's focus and caret: choose on press, not on the click after it.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(reply);
              }}
              className={cn(
                'cursor-pointer px-3 py-2',
                index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent',
              )}
            >
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-primary">/{reply.shortcut}</span>
                <span className="truncate text-sm font-medium">{reply.title}</span>
                {reply.category === null ? null : (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {reply.category}
                  </span>
                )}
              </span>
              <span
                lang={hasBangla(reply.body) ? 'bn' : undefined}
                className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground"
              >
                {reply.body}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>{t('inbox.saved.pickHint')}</span>
        {mayManage ? (
          <Link
            to="/settings/inbox"
            hash="saved-replies"
            onMouseDown={(event) => event.preventDefault()}
            className="ml-auto underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {t('inbox.saved.manage')}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
