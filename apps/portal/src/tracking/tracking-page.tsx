import { fontClassFor, formatDate, type Locale } from '@elysium/i18n';
import { Button, Money, cn, controlClassName } from '@elysium/ui';
import { Check, Loader2, Moon, PackageSearch, Sun } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { applyTheme, isDark } from '../theme.js';
import { track, type TrackingFound, type TrackingResult } from './api.js';
import { trackingText, type TrackingMessageKey } from './messages.js';
import { readyToSubmit } from './tracking-input.js';

/**
 * The public tracking page (M15: "order number plus the last 4 digits of the phone").
 *
 * Bangla by default (D-036) with an English toggle, light and dark, and usable on a phone
 * over a slow connection — which is where it is opened, from an SMS link.
 *
 * What it shows is what the server decided a customer may see: a stage out of five, the
 * courier's name and tracking code once the parcel is with one, what to pay at the door, and
 * the date of the last update. Never our internal status, never the phone number. A miss of
 * any kind is one sentence (`tracking.notFound`), because the server answers every miss with
 * the same bytes and the page must not add a distinction the server withheld.
 */

const FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

export function TrackingPage({ brand }: { readonly brand: string | null }) {
  const [locale, setLocale] = useState<Locale>('bn');
  const [dark, setDark] = useState(isDark);
  const t = (key: TrackingMessageKey) => trackingText(locale, key);

  const [orderNo, setOrderNo] = useState('');
  const [phoneLast4, setPhoneLast4] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TrackingResult | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const ids = { order: useId(), phone: useId(), orderHint: useId(), phoneHint: useId() };

  // `<html lang>` and the font stack follow the language: Bangla renders in Hind Siliguri
  // with its own size-adjust, and leaving the Latin stack on puts a mixed line on two baselines.
  useEffect(() => {
    const root = document.documentElement;
    root.lang = locale;
    root.classList.toggle('font-bangla', fontClassFor(locale) === 'font-bangla');
    root.classList.toggle('font-sans', fontClassFor(locale) === 'font-sans');
  }, [locale]);

  // Move focus to the answer, so a screen reader hears it and a phone scrolls to it.
  useEffect(() => {
    if (result !== null) resultRef.current?.focus();
  }, [result]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (brand === null) return;
    if (!readyToSubmit(orderNo, phoneLast4)) {
      setResult({ kind: 'invalid' });
      return;
    }
    setBusy(true);
    try {
      setResult(await track({ brand, orderNo: orderNo.trim(), phoneLast4: phoneLast4.trim() }));
    } finally {
      setBusy(false);
    }
  }

  /*
   * A buyer on a phone, usually from a link in an SMS (D-459): one narrow card on the warm
   * canvas, two fields and one button, and the answer as a timeline under it. Nothing else
   * competes for the screen.
   */
  return (
    <div className="min-h-dvh bg-canvas text-foreground">
      <header className="mx-auto flex h-14 max-w-md items-center justify-between px-4">
        <span className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
          <span
            aria-hidden="true"
            className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"
          >
            <PackageSearch className="size-4" />
          </span>
          {t('tracking.title')}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setLocale(locale === 'bn' ? 'en' : 'bn')}
            aria-label={t('tracking.languageLabel')}
            className={`inline-flex h-9 items-center rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${FOCUS}`}
          >
            <span lang={locale === 'bn' ? 'en' : 'bn'}>{t('tracking.language')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              applyTheme(dark ? 'light' : 'dark');
              setDark(!dark);
            }}
            aria-label={dark ? t('tracking.themeLight') : t('tracking.themeDark')}
            className={`inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${FOCUS}`}
          >
            {dark ? (
              <Sun aria-hidden="true" className="size-4" />
            ) : (
              <Moon aria-hidden="true" className="size-4" />
            )}
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-md space-y-5 px-4 pt-6 pb-16">
        <div className="space-y-1 px-1">
          <h1 className="text-lg font-semibold tracking-tight">{t('tracking.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('tracking.subtitle')}</p>
        </div>

        {brand === null ? (
          <p
            role="status"
            className="rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground"
          >
            {t('tracking.noBrand')}
          </p>
        ) : (
          <form
            onSubmit={(event) => void submit(event)}
            className="space-y-5 rounded-xl border border-border bg-card p-5 sm:p-6"
            noValidate
          >
            <div className="space-y-1.5">
              <label htmlFor={ids.order} className="block text-sm font-medium">
                {t('tracking.orderNo')}
              </label>
              <input
                id={ids.order}
                value={orderNo}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={60}
                aria-describedby={ids.orderHint}
                onChange={(event) => setOrderNo(event.target.value)}
                className={cn(controlClassName, 'min-h-11 w-full text-base tabular-nums')}
              />
              <p id={ids.orderHint} className="text-xs text-muted-foreground">
                {t('tracking.orderNoHint')}
              </p>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={ids.phone} className="block text-sm font-medium">
                {t('tracking.phoneLast4')}
              </label>
              <input
                id={ids.phone}
                value={phoneLast4}
                inputMode="numeric"
                autoComplete="off"
                maxLength={8}
                aria-describedby={ids.phoneHint}
                onChange={(event) => setPhoneLast4(event.target.value)}
                className={cn(
                  controlClassName,
                  'min-h-11 w-36 text-base tracking-widest tabular-nums',
                )}
              />
              <p id={ids.phoneHint} className="text-xs text-muted-foreground">
                {t('tracking.phoneLast4Hint')}
              </p>
            </div>
            <Button type="submit" size="lg" disabled={busy} className="min-h-11 w-full text-base">
              {busy ? (
                <Loader2
                  aria-hidden="true"
                  className="size-4 animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {busy ? t('tracking.checking') : t('tracking.submit')}
            </Button>
          </form>
        )}

        <div ref={resultRef} tabIndex={-1} aria-live="polite" className="outline-none">
          {result === null ? null : result.kind === 'found' ? (
            <Answer answer={result.answer} locale={locale} t={t} />
          ) : (
            <p
              role={result.kind === 'not_found' ? 'status' : 'alert'}
              className="rounded-xl border border-border bg-card px-5 py-4 text-sm"
            >
              {t(
                result.kind === 'not_found'
                  ? 'tracking.notFound'
                  : result.kind === 'rate_limited'
                    ? 'tracking.rateLimited'
                    : result.kind === 'invalid'
                      ? 'tracking.invalid'
                      : 'tracking.networkError',
              )}
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

function Answer({
  answer,
  locale,
  t,
}: {
  readonly answer: TrackingFound;
  readonly locale: Locale;
  readonly t: (key: TrackingMessageKey) => string;
}) {
  const ended = answer.stage === 'returned' || answer.stage === 'cancelled';
  return (
    <section
      aria-label={`${t('tracking.resultHeading')} ${answer.orderNo}`}
      className="space-y-5 rounded-xl border border-border bg-card p-5 motion-safe:animate-in sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tabular-nums">
          {t('tracking.resultHeading')} {answer.orderNo}
        </h2>
        <span className="rounded-xs bg-primary-subtle px-2 py-0.5 text-sm font-medium text-primary-text">
          {t(`tracking.stage.${answer.stage}` as TrackingMessageKey)}
        </span>
      </div>

      {/* A vertical timeline: done steps in a quiet tone, where the parcel is now in the
          accent, what is still to come faint (D-459). */}
      <ol className="relative">
        {answer.steps.map((step, index) => {
          const current =
            step.reached &&
            (index === answer.steps.length - 1 || !answer.steps[index + 1]?.reached);
          const last = index === answer.steps.length - 1;
          return (
            <li key={step.step} className="relative flex gap-3 pb-5 last:pb-0">
              {last ? null : (
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute top-6 bottom-0 left-[11px] w-px',
                    step.reached && answer.steps[index + 1]?.reached === true
                      ? 'bg-muted-foreground'
                      : 'bg-border',
                  )}
                />
              )}
              <span
                aria-hidden="true"
                className={cn(
                  'relative z-10 inline-flex size-6 shrink-0 items-center justify-center rounded-full',
                  current && !ended
                    ? 'bg-primary text-primary-foreground ring-4 ring-primary-subtle'
                    : step.reached
                      ? 'bg-muted-foreground text-background'
                      : 'border border-input bg-card',
                )}
              >
                {step.reached ? <Check className="size-3.5" strokeWidth={3} /> : null}
              </span>
              <span
                className={cn(
                  'pt-0.5 text-sm',
                  step.reached
                    ? current && !ended
                      ? 'font-semibold text-foreground'
                      : 'text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {t(`tracking.stage.${step.step}` as TrackingMessageKey)}
              </span>
            </li>
          );
        })}
      </ol>

      <dl className="grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
        {answer.courier === null ? null : (
          <>
            <div>
              <dt className="text-xs text-muted-foreground">{t('tracking.courier')}</dt>
              <dd className="font-medium">{answer.courier.name}</dd>
            </div>
            {answer.courier.trackingCode === null ? null : (
              <div>
                <dt className="text-xs text-muted-foreground">{t('tracking.trackingCode')}</dt>
                <dd className="font-medium tabular-nums">{answer.courier.trackingCode}</dd>
              </div>
            )}
          </>
        )}
        {ended || answer.stage === 'delivered' ? null : (
          <div>
            <dt className="text-xs text-muted-foreground">{t('tracking.cod')}</dt>
            <dd className="font-medium">
              <Money poisha={answer.codAmountPoisha} locale={locale} align="start" />
            </dd>
          </div>
        )}
        {answer.lastUpdateOn === null ? null : (
          <div>
            <dt className="text-xs text-muted-foreground">{t('tracking.lastUpdate')}</dt>
            <dd className="tabular-nums">{formatDate(answer.lastUpdateOn, { locale })}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
