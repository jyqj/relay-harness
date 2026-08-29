/** Outside-click and Escape dismissal for the Files source textarea. */

/** Options for `installFileEditorDismissal`. */
export interface FileEditorDismissalOptions {
  /** FilePreview element (`data-file-preview`). */
  root: HTMLElement
  /** Source textarea; blur and collapse its caret. */
  editor: { blur(): void; setSelectionRange?(start: number, end: number): void }
  /** When true, pointerdown and Escape do nothing. */
  isBlocked: () => boolean
  /** Clear the preview's selected line range. */
  onDismiss: () => void
}

function collapseEditorSelection(
  editor: FileEditorDismissalOptions['editor'],
): void {
  const caret = 'selectionStart' in editor && typeof (editor as { selectionStart?: number }).selectionStart === 'number'
    ? (editor as { selectionStart: number }).selectionStart
    : 0
  editor.setSelectionRange?.(caret, caret)
}

function dismissFileEditorInteraction({
  editor,
  onDismiss,
}: Pick<FileEditorDismissalOptions, 'editor' | 'onDismiss'>): void {
  onDismiss()
  editor.blur()
  collapseEditorSelection(editor)
}

function isFileEditorFocused(root: HTMLElement): boolean {
  const active = document.activeElement
  return active instanceof HTMLTextAreaElement && root.contains(active)
}

/**
 * Dismiss the Files textarea selection on pointerdown outside `root` or Escape
 * while that textarea is focused. `isBlocked` skips both handlers (a comment
 * overlay would set it). Cleanup removes the document listeners.
 * @param options - the preview root, its textarea, and the dismissal hooks.
 * @returns a disposer that removes the listeners.
 */
export function installFileEditorDismissal(options: FileEditorDismissalOptions): () => void {
  const { root, editor, isBlocked, onDismiss } = options
  const handlePointerDown = (event: PointerEvent): void => {
    if (isBlocked() || event.composedPath().includes(root)) return
    dismissFileEditorInteraction({ editor, onDismiss })
  }
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || isBlocked() || !isFileEditorFocused(root)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    dismissFileEditorInteraction({ editor, onDismiss })
  }

  document.addEventListener('pointerdown', handlePointerDown, true)
  document.addEventListener('keydown', handleKeyDown, true)
  return () => {
    document.removeEventListener('pointerdown', handlePointerDown, true)
    document.removeEventListener('keydown', handleKeyDown, true)
  }
}
