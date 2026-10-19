import { Button, DateTime, Skeleton, StatusBadge, cn } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { IdCard, MapPin, MessagesSquare, NotebookPen, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { useAbility } from '../../auth/session.js';
import { customerChats } from '../inbox/api.js';
import { getPerson } from './api.js';
import { AddressDialog, AddressList, DetailsDialog, DetailsList } from './customer-details.js';
import { usePeopleT } from './messages.js';
import { usePageActions } from './person-actions.js';

/**
 * The buyer page's own copies of what the inbox's customer card shows (M49, D-891 to D-895): the
 * details with the email, the address book, and the chats the buyer had with the notes written
 * in them. The same records the inbox edits, through the customer routes and the buyer's reach.
 */

function Card({
  icon: Icon,
  title,
  action,
  children,
  className,
}: {
  readonly icon: typeof IdCard;
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cn('overflow-hidden rounded-xl border border-border bg-card', className)}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Details and the address book, side by side on a wide screen. */
export function PersonCards({ customerId }: { readonly customerId: string }) {
  const t = usePeopleT();
  const ability = useAbility();
  const actions = usePageActions(customerId);
  const mayUpdate = ability.can('update', 'Customer');
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const person = useQuery({
    queryKey: ['people', customerId],
    queryFn: () => getPerson(customerId),
  });

  if (person.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    );
  }
  // The Numbers card above reports a failed read; a merged record has no cards of its own.
  if (person.isError || person.data.mergedIntoCustomerId !== null) return null;
  const data = person.data;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card
        icon={IdCard}
        title={t('people.details.title')}
        action={
          mayUpdate ? (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <NotebookPen aria-hidden="true" />
              {t('people.details.edit')}
            </Button>
          ) : null
        }
      >
        <div className="px-4 py-3">
          <DetailsList person={data} withDates={false} />
        </div>
      </Card>
      <Card
        icon={MapPin}
        title={t('people.addresses.title')}
        action={
          mayUpdate ? (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              {t('people.addresses.add')}
            </Button>
          ) : null
        }
      >
        {data.addresses.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">{t('people.addresses.none')}</p>
        ) : (
          <AddressList addresses={data.addresses} actions={mayUpdate ? actions : null} />
        )}
      </Card>
      {editing ? (
        <DetailsDialog person={data} actions={actions} onClose={() => setEditing(false)} />
      ) : null}
      {adding ? <AddressDialog actions={actions} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

/** The chats linked to this buyer and the notes written in them, for those who read the inbox. */
export function ChatsCard({ customerId }: { readonly customerId: string }) {
  const t = usePeopleT();
  const ability = useAbility();
  const allowed = ability.can('read', 'Conversation');
  const chats = useQuery({
    queryKey: ['people', customerId, 'chats'],
    queryFn: () => customerChats(customerId),
    enabled: allowed,
  });
  if (!allowed || chats.data === undefined) return null;
  const { conversations, notes } = chats.data;
  return (
    <Card icon={MessagesSquare} title={t('people.chats.title')}>
      {conversations.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('people.chats.none')}</p>
      ) : (
        <div>
          <ul className="divide-y divide-border">
            {conversations.map((chat) => (
              <li key={chat.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{chat.name ?? t('people.chats.unnamed')}</span>
                    <StatusBadge tone="neutral">
                      {t(`people.chats.channel.${chat.channel}`)}
                    </StatusBadge>
                    {chat.status === 'closed' ? (
                      <StatusBadge tone="neutral">{t('people.chats.closed')}</StatusBadge>
                    ) : null}
                  </p>
                  {chat.lastPreview === null ? null : (
                    <p className="truncate text-muted-foreground">{chat.lastPreview}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    <DateTime value={chat.lastMessageAt} compact />
                    {' · '}
                    {chat.assignedTo === null
                      ? t('people.chats.nobody')
                      : (chat.assignedTo.name ?? chat.assignedTo.userId)}
                  </p>
                </div>
                <Link
                  to="/inbox"
                  search={{ c: chat.id } as never}
                  className="shrink-0 rounded-full border border-input px-3 py-1 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {t('people.chats.open')}
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-border px-4 py-3">
            <h3 className="text-xs font-medium text-muted-foreground">{t('people.chats.notes')}</h3>
            {notes.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">{t('people.chats.noNotes')}</p>
            ) : (
              <ol className="mt-2 space-y-2">
                {notes.map((note) => (
                  <li key={note.id} className="rounded-lg bg-muted px-3 py-2">
                    <p className="text-sm break-words whitespace-pre-wrap">{note.body}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {note.author.name ?? note.author.userId} ·{' '}
                      <DateTime value={note.at} compact />
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
