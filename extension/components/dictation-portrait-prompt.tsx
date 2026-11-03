import { t } from '../lib/i18n';
import React from 'react';

export function DictationPortraitPrompt({ onDismiss }: { onDismiss?: () => void }) {
  return <div className="sl-dictation-rotate-prompt" role="status">
    <strong>{onDismiss ? t("建议使用竖屏听写") : t("请将 iPad 竖过来")}</strong>
    <span>{onDismiss ? t("软键盘可能遮挡内容；使用外接键盘时，按任意键即可继续。") : t("转为竖屏后会自动继续听写。")}</span>
    {onDismiss && <button type="button" className="sl-dictation-dismiss-portrait" onClick={onDismiss}>{t("关闭提示，横屏继续")}</button>}
  </div>;
}
