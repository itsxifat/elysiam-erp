// Applied before first paint so a dark-mode owner never sees a white flash. A file, not an
// inline script, so the console's Content-Security-Policy is `script-src 'self'` alone.
try {
  var saved = localStorage.getItem('owner-theme');
  var dark =
    saved === 'dark' || (saved !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
} catch (error) {
  // Storage denied: the OS preference applies on the first render instead.
}
