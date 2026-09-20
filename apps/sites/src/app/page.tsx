/*
 * M00 placeholder. M29 replaces this with the Puck renderer that resolves an
 * org from the request hostname and serves its published page.
 */
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-6">
      <h1 className="text-lg font-semibold tracking-tight">Elysium landing pages</h1>
      <p className="mt-1 text-sm text-muted-foreground">Multi-domain rendering arrives in M29.</p>
    </main>
  );
}
