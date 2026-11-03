import { timingSafeEqual } from "node:crypto";

/**
 * The method of passing access tokens. Putting them into a separate file is to allow the main desktop process to only reference these few constants.
 * There is no need to load the entire server along with the native SQLite module into the main process.
 */
export const ACCESS_TOKEN_COOKIE = "repolens_token";
export const ACCESS_TOKEN_HEADER = "x-repolens-token";

export function sameToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
