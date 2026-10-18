/** `deploy/images/Dockerfile.release` sets it from the `RELEASE_LINE` build argument (design §11). */
export const RELEASE_LINE_VARIABLE = 'GHCP_RELEASE_LINE';
export const DEFAULT_RELEASE_LINE = 'single';

/**
 * The image's release line (`single` or `multi`) as `/healthz` reports it. Unset means `single`: local runs and
 * images built before the variable existed. Any other value is reported as set, so a wrong image is visible.
 */
export function releaseLine(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env[RELEASE_LINE_VARIABLE]?.trim() || DEFAULT_RELEASE_LINE;
}
