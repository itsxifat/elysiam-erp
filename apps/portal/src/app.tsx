import { InvestorPortal } from './investor/portal.js';
import { TrackingPage } from './tracking/tracking-page.js';
import { brandFromPath, isTrackingPath } from './tracking/tracking-input.js';

/**
 * The portal's entry: the public tracking page at `/track/<brand>` (M15), and the investor
 * portal at `/investor` (M25) for everything else.
 *
 * Still a path check rather than a router. The portal has two pages and neither has a
 * parameter a router would parse for it (the tracking page reads its brand itself, and the
 * investor portal is one page whose sections are all about the signed-in person). The
 * reseller portal that would have given it a real route table is out of scope by the
 * client's instruction, so the first page that needs nested routes adds TanStack Router
 * here, as the console has it.
 *
 * Any other path is the investor portal, under its own path, because that is the only
 * signed-in thing the portal serves.
 */
export function PortalApp() {
  const path = window.location.pathname;
  if (isTrackingPath(path)) return <TrackingPage brand={brandFromPath(path)} />;
  if (path !== '/investor') window.history.replaceState(null, '', '/investor');
  return <InvestorPortal />;
}
