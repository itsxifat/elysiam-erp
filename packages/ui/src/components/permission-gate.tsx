import type { ReactNode } from 'react';

import { PermissionDeniedState } from './states.js';

/**
 * Hide a control a role cannot use — and say so plainly about what it is not.
 *
 * `.claude/rules/frontend.md`: "Use the shared CASL definitions to hide actions a
 * role can't take. **Treat the server as the only real permission check.**"
 * Both halves matter, and the second is the one that gets forgotten.
 *
 * This is a *usability* device. It stops a sales agent being shown an Approve
 * button that will 403, which is a small kindness and a large reduction in
 * support tickets. It is **not** a security boundary: the ability it consults is
 * computed in the browser from data the browser was given, and anybody can edit
 * that. The guard on the route is the control (M02b), the interceptor strips the
 * fields (invariant 5), and RLS is underneath both. If this component were the
 * only thing standing between a role and an action, the action would be open.
 *
 * Spelled out here because the failure mode is seductive: a gate that works
 * perfectly in every demo reads exactly like a permission system, and the next
 * person to add an endpoint may believe the checking has been done for them.
 *
 * Renders nothing by default. Most denied things should be absent rather than
 * explained — a sidebar with eleven greyed-out entries tells the user mainly
 * that the software is not for them. Pass `explain` for the cases where a
 * missing panel would look like a bug instead of a boundary.
 */
export interface PermissionGateProps {
  /**
   * Whether the caller may do the thing. Usually `ability.can(action, subject)`.
   *
   * A boolean rather than an `(action, subject)` pair, so the gate has no
   * opinion about where the answer came from and cannot be mistaken for the
   * place the decision is made.
   */
  readonly allowed: boolean;
  readonly children: ReactNode;
  /** Show the denied state instead of nothing. */
  readonly explain?: { readonly title: string; readonly detail?: string };
  /** Anything else — a disabled control, a tooltip — in place of the children. */
  readonly fallback?: ReactNode;
}

export function PermissionGate({ allowed, children, explain, fallback }: PermissionGateProps) {
  if (allowed) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  if (explain !== undefined) {
    return (
      <PermissionDeniedState
        title={explain.title}
        {...(explain.detail === undefined ? {} : { detail: explain.detail })}
      />
    );
  }
  return null;
}
