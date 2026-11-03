import { t } from '../../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import type { PageState } from '@shadow-language/contracts';
import { Icon } from '../icon';
import type { AgentMemory, KnowledgeDocument } from '../../lib/agent/store';
import { readKey, saveKey } from '../../lib/agent/credentials';
import { testKey } from '../../lib/agent/provider';

export type AgentSettingsDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onCredentialChange?: (key: string) => void;
  owner: string;
  page?: PageState | undefined;
  memories: AgentMemory[];
  documents: KnowledgeDocument[];
};

export function AgentSettingsDialog({ isOpen, onClose, onCredentialChange, owner }: AgentSettingsDialogProps) {
  const hostedAi = Boolean(import.meta.env.VITE_SHADOW_WEB);
  const [key, setKey] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : t("操作失败，请重试。"));

  useEffect(() => {
    if (isOpen) {
      setStatus('');
      setError('');
      if (!hostedAi) void readKey().then(setKey).catch(fail);
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
    }
  }, [hostedAi, isOpen]);

  const persistKey = async (value: string) => {
    await saveKey(value);
    onCredentialChange?.(value.trim());
  };

  const handleTestAndSave = async () => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 45000);
    setBusy(true);
    setStatus(t("正在测试连接和工具调用…"));
    setError('');
    try {
      const result = await testKey(key, abort.signal);
      await persistKey(key);
      setStatus(t("连接和工具调用正常 · {0} 秒", (result.elapsedMs / 1000).toFixed(1)));
    } catch (e) {
      fail(e);
      setStatus('');
    } finally {
      clearTimeout(timeout);
      setBusy(false);
    }
  };

  if (!isOpen) return null;
  const signedIn = owner.startsWith('user:');

  return (
    <dialog ref={dialogRef} className="agent-settings-dialog" onCancel={onClose} aria-label={hostedAi ? t("AI 服务") : t("AI 设置")}>
      <div className="agent-settings-container">
        <header className="agent-settings-header">
          <div className="agent-settings-tabs">
            <button type="button" className="active" aria-current="page">
              <span><Icon name="zap" /> {hostedAi ? t("AI 服务") : t("AI 模型")}</span>
            </button>
          </div>
          <button type="button" className="agent-icon-btn close-btn" onClick={onClose} aria-label={t("关闭设置")}>
            <Icon name="close" size={16} />
          </button>
        </header>

        {error && (
          <div className="agent-error" role="alert">
            {error}
            <button type="button" aria-label={t("关闭错误提示")} onClick={() => setError('')}><Icon name="close" /></button>
          </div>
        )}
        {status && <div className="agent-settings-status" role="status">{status}</div>}

        <div className="agent-settings-body">
          <div className="agent-settings-section">
            <div className="agent-section-header">
              <h4>DeepSeek V4.1 Flash{hostedAi ? '' : t("模型配置")}</h4>
              <p className="muted-desc">
                {hostedAi
                  ? t("Web 端由 Shadow Language 云端统一提供，使用时不需要填写 API Key。")
                  : t("插件端使用你提供的 API Key，Key 仅保存在本机浏览器中。对话与提问时会把相关上下文和学习资料直接发送给 DeepSeek。")}
              </p>
            </div>

            {hostedAi ? (
              <div className="agent-settings-status" role="status">
                {signedIn ? t("服务已就绪") : t("登录 Shadow Language 账号后即可使用")}
              </div>
            ) : (
              <>
                <label className="agent-form-field">
                  <span>API Key</span>
                  <input type="password" autoComplete="off" placeholder="sk-..." value={key} onChange={(e) => setKey(e.target.value)} />
                </label>
                <details className="agent-api-key-help">
                  <summary>{t("如何获取 API Key？")}</summary>
                  <div className="agent-api-key-help-content">
                    <ol>
                      <li>{t("登录或注册 DeepSeek 开放平台账号。")}</li>
                      <li>{t("在「API keys」页面创建 API Key，并复制生成的密钥。")}</li>
                      <li>{t("回到这里粘贴密钥，点击「测试并保存」。")}</li>
                    </ol>
                    <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noopener noreferrer">
                      {t("前往 DeepSeek 获取 API Key")}<Icon name="external" />
                    </a>
                    <p>{t("API 调用按用量计费，实际用量取决于对话长度。如提示余额不足，请到开放平台充值后重试。")}</p>
                  </div>
                </details>
                <div className="agent-dialog-actions">
                  <button type="button" onClick={() => void persistKey(key).then(() => setStatus(t("已保存 Key"))).catch(fail)}>{t("保存 Key")}</button>
                  <button type="button" disabled={busy || !key.trim()} onClick={() => void handleTestAndSave()}>
                    {busy ? t("测试中…") : t("测试并保存")}
                  </button>
                  <button type="button" className="danger-btn" onClick={() => void persistKey('').then(() => {
                    setKey('');
                    setStatus(t("已清除 Key"));
                  }).catch(fail)}>{t("删除 Key")}</button>
                </div>
                <small className="muted-note">{t("测试连通性会消耗极少量 API Token。")}</small>
              </>
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
