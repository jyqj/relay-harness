/**
 * A short fingerprint of a file's contents, used to tell one revision of a
 * file from another in cache keys. FNV-1a over the text, prefixed by its
 * length; collisions only cost a stale cache entry, so speed beats strength.
 * @param contents - the file's text.
 * @returns a revision token.
 */
export function fileContentRevision(contents: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < contents.length; index += 1) {
    hash ^= contents.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return `${contents.length}:${(hash >>> 0).toString(36)}`
}

/**
 * Cache key for one revision of one file in one project.
 * @param cwd - the project directory the file belongs to.
 * @param relativePath - the file's path within that project.
 * @param contents - the file's text.
 * @returns a key that changes whenever any of the three does.
 */
export function projectFileCacheKey(cwd: string, relativePath: string, contents: string): string {
  return `${cwd}:${relativePath}:${fileContentRevision(contents)}`
}

interface EditorFileIdentity {
  readonly cacheKey?: string
  readonly contents: string
}

/**
 * Cache key for a file open in the editor. An editor that already holds the
 * same text keeps its existing key, so unrelated remounts do not discard
 * editor state the key identifies.
 * @param environmentId - the environment the editor is attached to.
 * @param cwd - the project directory the file belongs to.
 * @param relativePath - the file's path within that project.
 * @param contents - the file's text.
 * @param editorFile - the file the editor currently holds, when it has one.
 * @returns the editor's existing key when its text is unchanged, else a new one.
 */
export function projectFileEditorCacheKey(
  environmentId: string,
  cwd: string,
  relativePath: string,
  contents: string,
  editorFile: EditorFileIdentity | undefined,
): string {
  if (editorFile?.contents === contents && editorFile.cacheKey) {
    return editorFile.cacheKey
  }
  return `editor:${environmentId}:${projectFileCacheKey(cwd, relativePath, contents)}`
}
