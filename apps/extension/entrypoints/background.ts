export default defineBackground(() => {
  // M28 adds enrolment with a one-time code, 30-second domain-only
  // heartbeats, 2-minute batching and an offline buffer.
  console.warn('elysium agent activity: ready');
});
