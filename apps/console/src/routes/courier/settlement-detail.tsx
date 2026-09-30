import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Money,
  PermissionGate,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { getSettlement, rejectSettlement, requestSettlementApproval } from './api.js';
import { courierPath, CourierHeader, Field, paramOf } from './courier-nav.js';
import { MATCH_TONE, SETTLEMENT_TONE } from './courier-ui.js';
import { useCourierT, type CourierMessageKey } from './messages.js';

/**
 * One courier statement: its totals, its exceptions, and the maker's two actions (§9).
 *
 * The exceptions are the screen: a row that did not match is a parcel whose cash the courier
 * says one thing about and our books another, and it will not post. They are listed with our
 * expected figure beside the courier's, and the fix is always with the courier followed by a
 * re-import — never an edit here, because a statement's lines are append-only evidence.
 *
 * "Request approval" raises the `settlement_posting` request for the matched gross (D-126);
 * the checker decides on the Approvals screen, and that decision is what posts the journals.
 * Below the org's threshold the request is decided at once and the batch posts in the same
 * step (D-130), which the status badge then shows.
 */
export function SettlementDetailPage() {
  const t = useCourierT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const settlementId = paramOf(useParams({ strict: false }), 'settlementId');

  const mayRead = ability.can('read', 'CourierSettlement');
  const mayAct = ability.can('update', 'CourierSettlement');

  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const batch = useQuery({
    queryKey: ['courier', 'settlement', settlementId],
    queryFn: () => getSettlement(settlementId),
    enabled: mayRead && settlementId !== '',
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['courier'] });

  const reject = useMutation({
    mutationFn: () => rejectSettlement(settlementId, reason.trim()),
    onSuccess: () => {
      setRejecting(false);
      setReason('');
      invalidate();
    },
  });

  const data = batch.data;
  const exceptions = (data?.lines ?? []).filter((line) => line.match !== 'matched');

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('courier.deniedTitle'), detail: t('courier.deniedDetail') }}
    >
      <div className="space-y-5">
        <Link
          to={courierPath('/courier/settlements')}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t('courier.back')}
        </Link>

        <CourierHeader
          title={`${t('courier.settlements.detailHeading')} ${data?.reference ?? ''}`}
          caption={t('courier.settlements.caption')}
          actions={
            mayAct && data?.status === 'imported' ? (
              <>
                <Button size="sm" onClick={() => setConfirming(true)}>
                  {t('courier.settlements.requestApproval')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setRejecting(true)}>
                  {t('courier.settlements.reject')}
                </Button>
              </>
            ) : undefined
          }
        />

        {notice === null ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}

        {batch.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : batch.isError || data === undefined ? (
          <ErrorState
            title={t('courier.errorTitle')}
            detail={
              batch.error instanceof ApiError ? batch.error.message : t('courier.errorDetail')
            }
            action={
              <Button size="sm" variant="outline" onClick={() => void batch.refetch()}>
                {t('courier.retry')}
              </Button>
            }
          />
        ) : (
          <>
            <section
              aria-label={t('courier.settlements.detailHeading')}
              className="grid gap-4 rounded-lg border border-border p-4 sm:grid-cols-3 lg:grid-cols-6"
            >
              <Figure label={t('courier.colStatus')}>
                <StatusBadge tone={SETTLEMENT_TONE[data.status]}>
                  {t(`courier.settlements.status.${data.status}` as CourierMessageKey)}
                </StatusBadge>
              </Figure>
              <Figure label={t('courier.settlements.colDate')}>
                <span className="tabular-nums">{data.settlementDate}</span>
              </Figure>
              <Figure label={t('courier.settlements.colGross')}>
                <Money poisha={data.matchedGrossPoisha} align="start" />
              </Figure>
              <Figure label={t('courier.settlements.colCharges')}>
                <Money poisha={data.matchedChargesPoisha} align="start" />
              </Figure>
              <Figure label={t('courier.settlements.colNet')}>
                <Money poisha={data.matchedNetPoisha} align="start" className="font-semibold" />
              </Figure>
              <Figure label={t('courier.settlements.matchedRows')}>
                <span className="tabular-nums">
                  {data.matchedRowCount} / {data.fileRowCount}
                </span>
              </Figure>
              {data.postingBusinessDate === null ? null : (
                <Figure label={t('courier.settlements.postedOn')}>
                  <span className="tabular-nums">{data.postingBusinessDate}</span>
                  {data.deferredFromClosedPeriod ? (
                    <span className="block text-xs text-muted-foreground">
                      {t('courier.settlements.deferred')}
                    </span>
                  ) : null}
                </Figure>
              )}
            </section>

            <section aria-labelledby="exceptions-heading" className="space-y-2">
              <div>
                <h2 id="exceptions-heading" className="text-sm font-semibold">
                  {t('courier.settlements.exceptionsHeading')}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {t('courier.settlements.exceptionsCaption')}
                </p>
              </div>
              {exceptions.length === 0 ? (
                <EmptyState title={t('courier.settlements.noExceptions')} />
              ) : (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <caption className="sr-only">
                      {t('courier.settlements.exceptionsHeading')}
                    </caption>
                    <thead>
                      <tr className="border-b border-border bg-muted text-left text-xs text-muted-foreground">
                        <th scope="col" className="px-3 py-2 text-right">
                          {t('courier.settlements.colRow')}
                        </th>
                        <th scope="col" className="px-3 py-2">
                          {t('courier.colConsignment')}
                        </th>
                        <th scope="col" className="px-3 py-2">
                          {t('courier.colOrder')}
                        </th>
                        <th scope="col" className="px-3 py-2">
                          {t('courier.settlements.colMatch')}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right">
                          {t('courier.colCollected')}
                        </th>
                        <th scope="col" className="px-3 py-2 text-right">
                          {t('courier.settlements.colExpected')}
                        </th>
                        <th scope="col" className="px-3 py-2">
                          {t('courier.colNote')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {exceptions.map((line) => (
                        <tr key={line.id} className="h-row border-b border-border last:border-0">
                          <td className="px-3 text-right tabular-nums">{line.rowNo}</td>
                          <td className="px-3 tabular-nums">{line.consignmentNo}</td>
                          <td className="px-3 tabular-nums">{line.reference ?? '—'}</td>
                          <td className="px-3">
                            <StatusBadge tone={MATCH_TONE[line.match]}>
                              {t(`courier.settlements.match.${line.match}` as CourierMessageKey)}
                            </StatusBadge>
                          </td>
                          <td className="px-3 text-right">
                            <Money poisha={line.codCollectedPoisha} />
                          </td>
                          <td className="px-3 text-right">
                            {line.expectedPoisha === null ? (
                              '—'
                            ) : (
                              <Money poisha={line.expectedPoisha} />
                            )}
                          </td>
                          <td className="px-3 text-muted-foreground">{line.note ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        <ConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={t('courier.settlements.requestApprovalTitle')}
          description={t('courier.settlements.requestApprovalDetail')}
          confirmLabel={t('courier.settlements.requestApproval')}
          cancelLabel={t('courier.cancel')}
          closeLabel={t('courier.close')}
          onConfirm={async () => {
            try {
              await requestSettlementApproval(settlementId);
              setNotice(t('courier.settlements.approvalRequested'));
            } catch (error) {
              setNotice(error instanceof ApiError ? error.message : t('courier.errorTitle'));
            } finally {
              setConfirming(false);
              invalidate();
            }
          }}
        >
          {data === undefined ? null : (
            <p className="text-sm">
              {t('courier.settlements.colGross')}:{' '}
              <Money poisha={data.matchedGrossPoisha} align="start" />
            </p>
          )}
        </ConfirmDialog>

        <Dialog
          open={rejecting}
          onOpenChange={setRejecting}
          title={t('courier.settlements.rejectTitle')}
          description={t('courier.settlements.rejectDetail')}
          closeLabel={t('courier.close')}
          footer={
            <>
              <Button variant="outline" onClick={() => setRejecting(false)}>
                {t('courier.cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={reason.trim() === '' || reject.isPending}
                onClick={() => reject.mutate()}
              >
                {t('courier.settlements.reject')}
              </Button>
            </>
          }
        >
          <Field label={t('courier.settlements.reasonLabel')} id="settlement-reject-reason">
            <textarea
              id="settlement-reject-reason"
              rows={3}
              maxLength={500}
              value={reason}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </Dialog>
      </div>
    </PermissionGate>
  );
}

function Figure({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}
