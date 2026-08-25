/** One segment of the path trail above an open file. */
export interface FileBreadcrumb {
  /** What the segment reads as. */
  label: string
  /** Project-relative path the segment navigates to; empty at the project root. */
  path: string
  /** What the segment points at, which decides its affordance. */
  kind: 'project' | 'directory' | 'file'
}

/**
 * The path trail from the project root down to one file.
 * @param projectName - what the root segment reads as.
 * @param relativePath - the file's path within the project.
 * @returns the trail, root first, with the file last.
 */
export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const parts = relativePath.split('/').filter(Boolean)
  return [
    { label: projectName, path: '', kind: 'project' },
    ...parts.map((part, index) => ({
      label: part,
      path: parts.slice(0, index + 1).join('/'),
      kind: index === parts.length - 1 ? ('file' as const) : ('directory' as const),
    })),
  ]
}
