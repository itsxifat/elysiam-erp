import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';

import { applyTheme, isDark } from './theme.js';

/*
 * M00 placeholder.
 *
 * It exists to prove three things end to end before M05 builds the real shell:
 * Tailwind resolves the design tokens, both themes render from the same
 * markup, and no raw palette colour is needed to build a page. The class names
 * below are all semantic tokens, which is what the ESLint rule enforces.
 */

const SWATCHES = [
  { label: 'Primary', className: 'bg-primary text-primary-foreground' },
  { label: 'Secondary', className: 'bg-secondary text-secondary-foreground' },
  { label: 'Muted', className: 'bg-muted text-muted-foreground' },
  { label: 'Delivered', className: 'bg-success-subtle text-success-subtle-foreground' },
  { label: 'Pending', className: 'bg-warning-subtle text-warning-subtle-foreground' },
  { label: 'Returned', className: 'bg-destructive-subtle text-destructive-subtle-foreground' },
] as const;

export function App() {
  const [dark, setDark] = useState(isDark);

  function toggleTheme() {
    const next = !dark;
    applyTheme(next ? 'dark' : 'light');
    setDark(next);
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="flex h-14 items-center justify-between border-b border-border px-6">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight">Elysium Console</span>
          <span className="text-xs text-muted-foreground">Staff operations</span>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-lg font-semibold tracking-tight">Design tokens are wired</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every colour below resolves through packages/ui. M05 replaces this page with the real
          application shell.
        </p>

        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {SWATCHES.map((swatch) => (
            <div
              key={swatch.label}
              className={`${swatch.className} flex h-16 items-center justify-center rounded-lg border border-border text-sm font-medium`}
            >
              {swatch.label}
            </div>
          ))}
        </div>

        <table className="mt-8 w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-border text-sm">
          <thead>
            <tr className="bg-muted text-muted-foreground">
              <th className="h-row px-3 text-left font-medium">Order</th>
              <th className="h-row px-3 text-left font-medium">Status</th>
              <th className="h-row px-3 text-right font-medium" data-numeric>
                COD
              </th>
            </tr>
          </thead>
          <tbody>
            {[
              ['ELB-2609-00421', 'Confirmed', '2,450.00'],
              ['ELB-2609-00420', 'Pending', '1,180.00'],
              ['ELB-2609-00419', 'Shipped', '12,900.00'],
            ].map(([order, status, amount]) => (
              <tr key={order} className="border-t border-border hover:bg-accent">
                <td className="h-row px-3 font-medium">{order}</td>
                <td className="h-row px-3 text-muted-foreground">{status}</td>
                <td className="h-row px-3" data-numeric>
                  &#2547;{amount}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </main>
    </div>
  );
}
