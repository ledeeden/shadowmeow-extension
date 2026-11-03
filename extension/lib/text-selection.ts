/** Selection.anchorNode is retargeted to the host for a document selection in Shadow DOM. */
export function selectionIn(element: HTMLElement): Selection | null {
  const root = element.getRootNode() as ShadowRoot & { getSelection?: () => Selection | null };
  return root.getSelection?.() || element.ownerDocument.getSelection();
}

export function selectedTextIn(element: HTMLElement): string {
  const selection = selectionIn(element);
  if (!selection || selection.isCollapsed) return '';
  if (selection.anchorNode && element.contains(selection.anchorNode)) return selection.toString().replace(/\s+/g, ' ').trim();
  const composed = selection as Selection & { getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[] };
  const root = element.getRootNode();
  if (root instanceof ShadowRoot && composed.getComposedRanges) {
    const range = composed.getComposedRanges({ shadowRoots: [root] })[0];
    if (range && element.contains(range.startContainer) && element.contains(range.endContainer)) {
      const visible = document.createRange();
      visible.setStart(range.startContainer, range.startOffset); visible.setEnd(range.endContainer, range.endOffset);
      return visible.toString().replace(/\s+/g, ' ').trim();
    }
  }
  return '';
}
