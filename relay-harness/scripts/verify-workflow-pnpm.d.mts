/** Require every block-style pnpm setup step to own its nested manifest path. */
export function verifyPnpmSetupPaths(text: string, name: string): number
/** Check root workflows before third-party dependencies are available. */
export function verifyWorkflowPnpm(directory: string): Promise<number>
