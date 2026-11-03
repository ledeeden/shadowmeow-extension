import { t } from '../lib/i18n';
import { useEffect, useState } from 'react';
import type { ReleaseCheck } from '../lib/extension-release';
import { unwrapRuntimeResponse } from '../lib/runtime-errors';
import './extension-update-notice.css';

export function ExtensionUpdateNotice({ showCheck = false }: { showCheck?: boolean }) {
  const [result, setResult] = useState<ReleaseCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const check = async (force: boolean) => {
    setBusy(true);
    setError('');
    try {
      const response = unwrapRuntimeResponse(await browser.runtime.sendMessage({ type: 'EXTENSION_UPDATE_CHECK', force }), { includeDiagnostics: false }) as ReleaseCheck;
      if (!response || typeof response.available !== 'boolean') throw new Error(t("检查更新失败"));
      setResult(response as ReleaseCheck);
    } catch (cause) {
      if (force) setError(cause instanceof Error ? cause.message : t("检查更新失败，请稍后重试"));
    } finally { setBusy(false); }
  };
  // Automatic checks honor the six-hour cache. Only the explicit button
  // bypasses it, so dashboard/side-panel remounts cannot amplify requests.
  useEffect(() => { if (!import.meta.env.VITE_SHADOW_WEB) void check(false); }, []);
  if (import.meta.env.VITE_SHADOW_WEB) return null;
  if (!showCheck && !result?.available) return null;
  return <aside className="extension-update" aria-label={t("插件更新")}>
    {result?.available && result.release ? <>
      <div className="extension-update-heading"><strong>{t("新版本")}{result.release.version}</strong><a href={result.release.downloadUrl} target="_blank" rel="noreferrer">{t("下载 ZIP")}</a></div>
      <p>{t("解压后覆盖原插件目录，在 Chrome 扩展管理页点击「重新加载」，再刷新视频页面。不要先卸载插件。")}</p>
    </> : <span>{t("当前版本")}{browser.runtime.getManifest().version}{result ? t("· 暂无新版本") : ''}</span>}
    {showCheck && <button type="button" disabled={busy} onClick={() => void check(true)}>{busy ? t("检查中…") : t("检查更新")}</button>}
    {error && <p role="alert">{error}</p>}
  </aside>;
}
