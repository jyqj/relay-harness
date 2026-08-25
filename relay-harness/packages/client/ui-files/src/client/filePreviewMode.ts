/**
 * Whether a file opens in the rendered Markdown preview rather than the source
 * editor, which the Files pane decides from the extension alone.
 * @param path - the file's path.
 * @returns true for `.md` and `.mdx`.
 */
export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path)

/**
 * Toggle one Markdown task checkbox in place, editing the source rather than
 * the rendered output so the file keeps its exact formatting. An offset that
 * does not point at a `[ ]` or `[x]` marker — the document changed under a
 * stale render — leaves the text alone.
 * @param markdown - the file's source.
 * @param markerOffset - offset of the marker's opening bracket.
 * @param checked - the state to write.
 * @returns the edited source, or the original when the offset is stale.
 */
export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== '[' ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? '') ||
    markdown[markerOffset + 2] !== ']'
  ) {
    return markdown
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? 'x' : ' '}${markdown.slice(markerOffset + 2)}`
}
