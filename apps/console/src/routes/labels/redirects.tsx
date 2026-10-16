import { Navigate, useSearch } from '@tanstack/react-router';

/**
 * Orders → Pack and Orders → Hub moved to Packaging (M46, D-800): an old bookmark or link lands
 * there, the order it named open at the packing station.
 */
export function ToPackaging() {
  const search: unknown = useSearch({ strict: false });
  const order = (search as { order?: unknown } | undefined)?.order;
  return (
    <Navigate
      to="/packaging"
      search={(typeof order === 'string' ? { tab: 'packing', order } : {}) as never}
      replace
    />
  );
}
