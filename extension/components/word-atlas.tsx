import { t } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icon';
import { cancelEnglishSpeech, speakEnglish } from '../lib/speech';
import { atlasMedia, findAtlasEntry, type AtlasEntry } from '../lib/word-atlas';
import wordAtlasStyles from './word-atlas.css?inline';

export function WordAtlas({ word, enabled = true, revealed = true, lesson = false, onBeforePlay }: { word: string; enabled?: boolean; revealed?: boolean; lesson?: boolean; onBeforePlay?: () => void }) {
  const [entry, setEntry] = useState<AtlasEntry | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const request = useRef(0);
  const ownsSpeech = useRef(false);
  useEffect(() => {
    let active = true;
    setEntry(null); setImageFailed(false); setPlaying(null);
    if (enabled) void findAtlasEntry(word).then(value => { if (active) setEntry(value); });
    return () => { active = false; request.current++; audio.current?.pause(); audio.current = null; if (ownsSpeech.current) cancelEnglishSpeech(); ownsSpeech.current = false; };
  }, [word, enabled]);
  if (!entry) return null;
  const img = atlasMedia(entry, 'img');
  function play(kind: 'uk' | 'us' | 'ex' | 'ex2', text: string) {
    onBeforePlay?.();
    const id = ++request.current;
    audio.current?.pause(); audio.current = null; cancelEnglishSpeech(); ownsSpeech.current = false;
    if (playing === kind) { setPlaying(null); return; }
    setPlaying(kind);
    const finish = () => { if (id === request.current) { ownsSpeech.current = false; setPlaying(null); } };
    let fellBack = false;
    const fallback = () => { if (id !== request.current || fellBack) return; fellBack = true; ownsSpeech.current = true; if (!speakEnglish(text, { onend: finish, onerror: finish })) finish(); };
    const url = atlasMedia(entry!, kind);
    if (!url) { fallback(); return; }
    const player = new Audio(url); audio.current = player;
    player.onended = finish;
    player.onerror = fallback;
    void player.play().catch(fallback);
  }
  if (lesson) return <section className="word-atlas is-lesson atlas-lesson" aria-label={t("Word Atlas {0} 词条", entry.w)}>
    <style>{wordAtlasStyles}</style>
    {img && !imageFailed && <img className="atlas-lesson-art" src={img} alt={t("{0} 的词光插画", entry.w)} onError={() => setImageFailed(true)} />}
    <header className="atlas-lesson-title">
      <small>{t("认识这个词")}</small><h3 className="word-atlas-headword" lang="en">{entry.w}</h3>
      <div className="word-atlas-audio">{(['uk', 'us'] as const).map(kind => <button key={kind} type="button" onClick={() => play(kind, entry.w)}><Icon name={playing === kind ? 'stop' : 'volume'} /><span>{kind === 'uk' ? t("英") : t("美")} {entry[kind]}</span></button>)}</div>
    </header>
    <div className="atlas-lesson-definition">{entry.senses.slice(0, 1).map((sense, i) => <p key={i}><b><em>{sense.pos}</em> {sense.zh}</b>{sense.en && <span>{sense.en}</span>}</p>)}</div>
    {entry.ex[0] && <div className="atlas-lesson-example"><small>{t("放进一句话里")}</small><div className="word-atlas-example"><button type="button" onClick={() => play('ex', entry.ex[0]!.en)} aria-label={t("朗读词光例句 1")}><Icon name={playing === 'ex' ? 'stop' : 'volume'} /></button><p lang="en">{entry.ex[0].en}<span lang="zh-CN">{entry.ex[0].zh}</span></p></div></div>}
    <details className="atlas-lesson-more"><summary>{t("更多释义与用法")}</summary>
      {entry.senses.slice(1).map((sense, i) => <p key={i}><b>{sense.pos} {sense.zh}</b><span>{sense.en}</span></p>)}
      {entry.ex.slice(1).map((example, i) => <div className="word-atlas-example" key={i}><button type="button" onClick={() => play('ex2', example.en)} aria-label={t("朗读词光例句 2")}><Icon name="volume" /></button><p>{example.en}<span>{example.zh}</span></p></div>)}
      {entry.col.length > 0 && <p>{t("搭配：")}{entry.col.join(' · ')}</p>}{entry.fam.length > 0 && <p>{t("词族：")}{entry.fam.join(' · ')}</p>}{entry.tip && <p>{entry.tip}</p>}{entry.note && <p>{entry.note}</p>}
      <small className="word-atlas-credit">{t("内容：")}<a href="https://github.com/designfuchen/word-atlas" target="_blank" rel="noreferrer">Word Atlas contributors</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></small>
    </details>
  </section>;
  return <section className={`word-atlas ${revealed ? 'is-revealed' : 'is-preview'} ${lesson ? 'is-lesson' : ''}`} aria-label={t("Word Atlas {0} 词条", entry.w)}>
    <style>{wordAtlasStyles}</style>
    <div className="word-atlas-heading"><strong>{t("词光图鉴 ·")}{entry.w}</strong><span>{revealed ? t("词条释义供参考，请结合原句理解") : t("先回想词义，再翻卡查看释义与例句")}</span></div>
    <div className="word-atlas-body">
      {img && !imageFailed && <img src={img} alt={t("{0} 的词光插画", entry.w)} loading="lazy" onError={() => setImageFailed(true)} />}
      <div className="word-atlas-content">

        <div className="word-atlas-audio">
          <button type="button" onClick={() => play('uk', entry.w)}>{playing === 'uk' ? t("停止") : t("英音")} {entry.uk}</button>
          <button type="button" onClick={() => play('us', entry.w)}>{playing === 'us' ? t("停止") : t("美音")} {entry.us}</button>
        </div>
        {revealed && entry.senses?.map((sense, i) => <p key={i}><b>{sense.pos} {sense.zh}</b>{sense.en && <span>{sense.en}</span>}</p>)}
      </div>
    </div>
    {revealed && entry.ex?.map((example, i) => <div className="word-atlas-example" key={i}>
      <button type="button" onClick={() => play(i === 0 ? 'ex' : 'ex2', example.en)} aria-label={t("{0}词光例句 {1}", playing === (i === 0 ? 'ex' : 'ex2') ? t("停止播放") : t("朗读"), i + 1)} title={playing === (i === 0 ? 'ex' : 'ex2') ? t("停止播放") : t("朗读例句")}><Icon name={playing === (i === 0 ? 'ex' : 'ex2') ? 'stop' : 'volume'} /></button>
      <p>{example.en}<span>{example.zh}</span></p>
    </div>)}
    {revealed && entry.col?.length > 0 && <p className="word-atlas-extra">{t("搭配：")}{entry.col.join(' · ')}</p>}
    {revealed && entry.fam?.length > 0 && <p className="word-atlas-extra">{t("词族：")}{entry.fam.join(' · ')}</p>}
    {revealed && entry.tip && <p className="word-atlas-extra">{entry.tip}</p>}
    {revealed && entry.note && <p className="word-atlas-extra">{entry.note}</p>}
    <small className="word-atlas-credit">{t("内容：")}<a href="https://github.com/designfuchen/word-atlas" target="_blank" rel="noreferrer">Word Atlas contributors</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></small>
  </section>;
}
