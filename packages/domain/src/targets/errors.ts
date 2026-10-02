/**
 * What the target and bonus arithmetic refuses (architecture §12, §23).
 *
 * Two codes, because the two mistakes are made by different people at different times: a
 * target that cannot be split is an HR officer's form, a bonus rule that cannot be read is
 * somebody's JSON — and the API answers each with the code a client branches on rather
 * than with a 500.
 */
export type TargetErrorCode = 'TARGET_INVALID' | 'BONUS_RULE_INVALID';

export class TargetError extends Error {
  constructor(
    readonly code: TargetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TargetError';
  }
}
