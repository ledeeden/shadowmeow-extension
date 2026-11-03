import { timeoutSignal } from '@shadow-language/contracts';
import { parseReleaseCheck, type ReleaseCheck } from './extension-release';
import releaseConfig from '../release-config.json';

const endpoint = import.meta.env.WXT_UPDATE_CHECK_URL || releaseConfig.checkUrl;
const CACHE_KEY = 'extension-release-check-v1';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
let pending: Promise<ReleaseCheck> | undefined;

export async function checkExtensionUpdate(force = false): Promise<ReleaseCheck> {
  if (!endpoint) throw new Error('此安装包尚未配置更新服务');
  const version = browser.runtime.getManifest().version;
  if (!force) {
    const stored = (await browser.storage.local.get(CACHE_KEY))[CACHE_KEY] as { version?: string; checkedAt?: number; result?: unknown } | undefined;
    if (stored?.version === version && typeof stored.checkedAt === 'number' && Date.now() - stored.checkedAt >= 0 && Date.now() - stored.checkedAt < CHECK_INTERVAL) {
      try { return parseReleaseCheck(stored.result, version); } catch { /* Ignore invalid cache. */ }
    }
  }
  if (pending) return pending;
  pending = (async () => {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('更新服务必须使用 HTTPS');
    url.searchParams.set('currentVersion', version);
    const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: timeoutSignal(15000) });
    if (!response.ok) throw new Error(`检查更新失败（${response.status}）`);
    const result = parseReleaseCheck(await response.json(), version);
    await browser.storage.local.set({ [CACHE_KEY]: { version, checkedAt: Date.now(), result } });
    return result;
  })();
  try { return await pending; } finally { pending = undefined; }
}
