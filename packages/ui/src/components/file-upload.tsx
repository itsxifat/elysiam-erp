import { CheckCircle2, Paperclip, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';

import { Button } from './button.js';
import { cn } from '../lib/cn.js';

/**
 * Upload through M04's presigned ticket (architecture §22).
 *
 * The flow is three steps and the order matters:
 *
 *   1. `POST /v1/files` — the server checks the ability, the purpose and the
 *      declared size, and issues a presigned PUT. The row is `pending`.
 *   2. `PUT` straight at storage, with the ticket's own headers. **The bytes
 *      never pass through the API.** A proxied upload holds a worker and a
 *      connection for the length of somebody's mobile upload, and an order desk
 *      attaching bKash screenshots over a 3G connection would occupy them all.
 *   3. `POST /v1/files/:id/finalize` — the server reads the object back, hashes
 *      it, measures it and sniffs its real type. Until this runs nothing can
 *      download the file, which is why a component that stops after step 2 looks
 *      like it works and produces files that are permanently invisible.
 *
 * This component performs all three and reports the finalized file, so no screen
 * can implement two of them.
 *
 * **The ticket's headers are sent verbatim and nothing is added.** A presigned
 * URL's signature covers the method, the key and the headers; adding a
 * `Content-Type` of our own, or omitting one the ticket asked for, produces a
 * 403 from storage that reads as a permissions bug and is not one.
 */

export interface UploadTicket {
  readonly fileId: string;
  readonly url: string;
  readonly method: 'PUT';
  readonly headers: Readonly<Record<string, string>>;
  readonly maxBytes: number;
}

export interface UploadedFile {
  readonly id: string;
  readonly originalName: string | null;
  readonly sizeBytes: number | null;
  readonly mime: string;
}

export interface FileUploadProps {
  /** `POST /v1/files`. Takes what the client claims; the server decides. */
  readonly createTicket: (input: {
    contentType: string;
    sizeBytes: number;
    originalName: string;
  }) => Promise<UploadTicket>;
  /** `POST /v1/files/:id/finalize`. Returns the row as the server now sees it. */
  readonly finalize: (fileId: string) => Promise<UploadedFile>;
  readonly onUploaded: (file: UploadedFile) => void;
  /**
   * The person took the attachment back. A form holding the file id clears it
   * here, or it would submit an attachment the screen no longer shows.
   */
  readonly onRemoved?: () => void;
  /** Passed to the input's `accept`. Advisory — the server sniffs the bytes. */
  readonly accept?: string;
  readonly disabled?: boolean;
  readonly labels: {
    readonly choose: string;
    readonly uploading: string;
    readonly uploaded: string;
    readonly remove: string;
    /** Shown for any failure. Never the raw error text (§23, ErrorState). */
    readonly failed: string;
    readonly tooLarge: string;
  };
  readonly className?: string;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'uploading'; readonly name: string }
  | { readonly kind: 'done'; readonly file: UploadedFile }
  | { readonly kind: 'failed'; readonly message: string };

export function FileUpload({
  createTicket,
  finalize,
  onUploaded,
  onRemoved,
  accept,
  disabled = false,
  labels,
  className,
}: FileUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  async function upload(file: File) {
    setPhase({ kind: 'uploading', name: file.name });
    try {
      const ticket = await createTicket({
        // The browser's guess. Declared so the server can refuse a ticket for a
        // type it does not allow, and checked again against the magic number at
        // finalize — this value is never evidence about anything.
        contentType: file.type === '' ? 'application/octet-stream' : file.type,
        sizeBytes: file.size,
        originalName: file.name,
      });

      if (file.size > ticket.maxBytes) {
        // Checked again after the ticket, because the limit is per MIME type and
        // only the server knows it. Failing here spends nothing; failing at
        // storage spends the whole upload first.
        setPhase({ kind: 'failed', message: labels.tooLarge });
        return;
      }

      const response = await fetch(ticket.url, {
        method: ticket.method,
        headers: { ...ticket.headers },
        body: file,
        // No credentials. The signature in the URL is the authorization, and
        // sending cookies to a storage origin is a habit worth not forming.
        credentials: 'omit',
      });
      if (!response.ok) {
        setPhase({ kind: 'failed', message: labels.failed });
        return;
      }

      const finalized = await finalize(ticket.fileId);
      setPhase({ kind: 'done', file: finalized });
      onUploaded(finalized);
    } catch {
      setPhase({ kind: 'failed', message: labels.failed });
    }
  }

  function reset() {
    setPhase({ kind: 'idle' });
    if (inputRef.current !== null) inputRef.current.value = '';
    onRemoved?.();
  }

  return (
    <div className={cn('space-y-2', className)}>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        // Out of the tab order: the button below opens it, and a second, invisible
        // stop on the same control is a focus ring nobody can see.
        tabIndex={-1}
        aria-hidden="true"
        {...(accept === undefined ? {} : { accept })}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void upload(file);
        }}
      />

      {phase.kind === 'done' ? (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm">
          <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
          <span className="min-w-0 flex-1 truncate">
            {phase.file.originalName ?? labels.uploaded}
          </span>
          <Button variant="ghost" size="icon" aria-label={labels.remove} onClick={reset}>
            <X aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          disabled={disabled || phase.kind === 'uploading'}
          onClick={() => inputRef.current?.click()}
        >
          {phase.kind === 'uploading' ? (
            <>
              <Upload aria-hidden="true" />
              {labels.uploading}
            </>
          ) : (
            <>
              <Paperclip aria-hidden="true" />
              {labels.choose}
            </>
          )}
        </Button>
      )}

      {phase.kind === 'uploading' ? (
        <p role="status" className="truncate text-xs text-muted-foreground">
          {phase.name}
        </p>
      ) : null}

      {phase.kind === 'failed' ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {phase.message}
        </p>
      ) : null}
    </div>
  );
}
