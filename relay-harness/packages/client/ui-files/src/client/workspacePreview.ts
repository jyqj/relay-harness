/** Extensions the workspace opens in the embedded browser rather than an editor. */
export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = ['.htm', '.html', '.pdf'] as const

/** Extensions the workspace renders as an image rather than as text. */
export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
] as const

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const pathWithoutQuery = path.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  return extensions.some(extension => pathWithoutQuery.endsWith(extension))
}

/**
 * Whether a path opens in the embedded browser.
 * @param path - the file's path, which may carry a query or fragment.
 * @returns true for the browser-preview extensions.
 */
export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS)
}

/**
 * Whether a path renders as an image.
 * @param path - the file's path, which may carry a query or fragment.
 * @returns true for the image-preview extensions.
 */
export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS)
}

/**
 * Whether a path opens in a preview at all, in either form.
 * @param path - the file's path, which may carry a query or fragment.
 * @returns true when the workspace previews the file instead of editing it.
 */
export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceImagePreviewPath(path)
}
