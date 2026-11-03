export type ExtensionRelease = {
  version: string;
  downloadUrl: string;
  sha256: string;
  size: number;
  publishedAt: string;
};

export type ReleaseCheck = { available: boolean; release: ExtensionRelease | null };

export function parseReleaseCheck(value: unknown, currentVersion: string): ReleaseCheck {
  if (!value || typeof value !== 'object' || !('release' in value)) throw new Error('版本信息格式异常');
  const release = (value as { release: unknown }).release;
  if (release === null) return { available: false, release: null };
  const item = release as ExtensionRelease;
  if (!item || typeof item.version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(item.version)
    || item.version.split('.').some((part) => Number(part) > 65535)
    || !item.version.split('.').some(Number)
    || typeof item.downloadUrl !== 'string'
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
    || !Number.isSafeInteger(item.size) || item.size <= 0
    || typeof item.publishedAt !== 'string' || !Number.isFinite(Date.parse(item.publishedAt))) throw new Error('版本信息格式异常');
  const url = new URL(item.downloadUrl);
  if (url.protocol !== 'https:' || url.username || url.password || !url.pathname.endsWith('.zip')) throw new Error('下载地址格式异常');
  const latest = item.version.split('.').map(Number);
  const current = currentVersion.split('.').map(Number);
  const index = latest.findIndex((part, i) => part !== current[i]);
  return { available: index >= 0 && latest[index]! > current[index]!, release: item };
}
