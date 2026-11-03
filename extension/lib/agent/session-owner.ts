/** AUTH_CHANGED also refreshes settings after sync; only identity changes end a run. */
export function createAgentOwnerRefresh(input: {
  readOwner: () => Promise<string>;
  onChange: (owner: string) => void;
  onError: (error: unknown) => void;
}) {
  let owner: string | undefined;
  let revision = 0;
  let disposed = false;
  return {
    async refresh() {
      const request = ++revision;
      try {
        const next = await input.readOwner();
        if (disposed || request !== revision || next === owner) return;
        owner = next;
        input.onChange(next);
      } catch (error) {
        if (!disposed && request === revision) input.onError(error);
      }
    },
    dispose() { disposed = true; revision++; },
  };
}
