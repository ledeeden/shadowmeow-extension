import { t } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { alignSentence, type ErrorSpan } from '../lib/sentence-alignment';
export type SentenceSubmissionProps={
  submissionMode:'whole-sentence';reference:string;heard:boolean;disabled?:boolean;autoFocus?:boolean;
  onSubmit:(spans:ErrorSpan[], answer:string)=>void;
};
/** Opt-in whole-answer submission. Existing guided typing remains unchanged. */
export function SentenceSubmission({reference,heard,disabled=false,autoFocus=false,onSubmit}:SentenceSubmissionProps) {
  const [answer,setAnswer]=useState('');
  const [error,setError]=useState('');
  const answerRef=useRef<HTMLTextAreaElement|null>(null);
  useEffect(()=>{
    if(!autoFocus||!heard||disabled)return;
    const frame=window.requestAnimationFrame(()=>answerRef.current?.focus({preventScroll:true}));
    return()=>window.cancelAnimationFrame(frame);
  },[autoFocus,disabled,heard]);
  function submit(){try{setError('');onSubmit(alignSentence(reference,answer),answer.trim());}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}}
  return <div className="sentence-submission sl-sentence-submission">
    <label htmlFor="onboarding-whole-answer">{t("写下你听到的完整句子")}</label>
    <textarea ref={answerRef} id="onboarding-whole-answer" autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoFocus={autoFocus} maxLength={600} rows={3} value={answer} disabled={!heard||disabled} onChange={event=>setAnswer(event.target.value)} placeholder={heard?t("不确定的部分可以留空；输入时不会纠正你。"):t("先完整听一遍，再写下听到的内容。")} />
    <p className="onb-muted">{t("提交后才对齐原句。不保存逐键输入，也不评价发音。")}</p>
    {error&&<p role="alert">{error}</p>}
    <button className="onb-primary" disabled={!heard||disabled} onClick={submit}>{answer.trim()?t("提交整句"):t("暂时没听出来，查看需要练习的部分")}</button>
  </div>;
}
