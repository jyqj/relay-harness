export function rotateWorkspaceSessionToken(previous: string): string {
  return `rotated:${previous}`
}
