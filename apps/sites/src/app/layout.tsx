import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
// Imported for its side effect: configuration is validated at build time.
import '@/env';

export const metadata: Metadata = {
  title: 'Elysiam',
  description: 'Landing pages for the Elysiam brands.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground">{children}</body>
    </html>
  );
}
