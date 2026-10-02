# A queue whose policy changed after it was created

The worker logs `queue policy drift` at boot, naming a queue, the policy the database
holds (`stored`) and the one the code asks for (`wanted`). `JobsRuntime.policyDrift()`
returns the same list.

## Why it happens

pg-boss sets a queue's policy when the queue is created. `createQueue` does nothing to a
queue that already exists, and `updateQueue` refuses to change a policy
(`queue policy cannot be changed after creation`, pg-boss 12.33.2). So a database created
before a release that made a queue `exclusive` keeps it `standard`.

On a `standard` queue a `singletonKey` is enforced by nothing (D-207). For
`delivery.book_parcel` that means two duplicate jobs, picked up by two workers at once,
can book one parcel with the courier twice.

## What to do

The queue has to be recreated, and it can only be recreated empty.

1. Stop the workers. Leave the API running: it keeps enqueueing, and the jobs wait.
2. Check what is waiting:
   `select state, count(*) from pgboss.job where name = '<queue>' group by state;`
3. Move the waiting jobs out of the way, so the queue is empty:
   `create table public.held_jobs as select * from pgboss.job where name = '<queue>' and state in ('created', 'retry');`
   then delete those rows from `pgboss.job`. `active` jobs belong to stopped workers and
   go back to `created` when they expire; wait for that, then repeat.
4. Delete and recreate the queue in one short window, with the API still running. A job
   enqueued between the two fails its transaction, and the caller retries:
   `select pgboss.delete_queue('<queue>');` then start one worker. `registerQueues`
   creates the queue with the policy the code asks for.
5. Re-insert the held jobs. On an `exclusive` queue a duplicate key is now refused, which
   is the point: re-insert with `on conflict do nothing` and read the count.
6. Start the remaining workers. The boot log must no longer say `queue policy drift`.

Do this in a quiet hour for the queue in question. For `delivery.book_parcel`, that is
after the evening's last courier handover.
