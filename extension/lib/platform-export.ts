export type PlatformExportResult = 'shared' | 'downloaded' | 'cancelled';
type NativeFileHost = typeof globalThis & {
  __shadowNativeExport?: (blob: Blob, filename: string, title?: string) => Promise<PlatformExportResult>;
};

/** Injected by the iOS host; shared extension code never imports native SDKs. */
export async function downloadPlatformFile(blob: Blob, filename: string, title?: string): Promise<PlatformExportResult> {
  const nativeExport = (globalThis as NativeFileHost).__shadowNativeExport;
  if (nativeExport) return nativeExport(blob, filename, title);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.style.display = 'none';
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}
