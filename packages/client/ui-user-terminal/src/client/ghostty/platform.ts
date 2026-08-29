/** Copied from the external desktop `apps/web/src/lib/utils.ts`. */

/**
 * Whether a platform string names an Apple platform, which decides whether
 * terminal shortcuts read Command or Control.
 * @param platform - `navigator.platform` or an equivalent token.
 * @returns true for macOS and iOS.
 */
export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}
