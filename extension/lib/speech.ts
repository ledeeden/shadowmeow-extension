/**
 * Pronunciation playback for English words and phrases.
 *
 * Uses the browser's built-in SpeechSynthesis (Web Speech API) so playback
 * works offline and with zero network latency. Voice selection prefers local
 * high-quality voices (Samantha, Microsoft Aria/Jenny/Neural, Google US
 * English, etc.) and caches the choice across calls.
 */

export type EnglishSpeechOptions = {
  rate?: number;
  onend?: () => void;
  onerror?: () => void;
};

const PREFERRED_VOICE_PATTERN = /samantha|allison|ava|natural|neural|aria|jenny|guy|google.*us|microsoft.*online.*english/i;

let cachedVoice: SpeechSynthesisVoice | null | undefined;
let cachedVoiceSnapshot = 0;

function getSpeech(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
}

function rankVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const english = voices.filter((voice) => /^en([-_]|$)/i.test(voice.lang));
  return english.sort((left, right) => {
    const score = (voice: SpeechSynthesisVoice): number => {
      const name = voice.name;
      const local = voice.localService ? 4 : 0;
      if (/^en[-_]?us$/i.test(voice.lang)) {
        if (PREFERRED_VOICE_PATTERN.test(name)) return 10 + local;
        return 6 + local;
      }
      if (/^en[-_]?gb$/i.test(voice.lang)) {
        if (PREFERRED_VOICE_PATTERN.test(name)) return 5 + local;
        return 3 + local;
      }
      return 1 + local;
    };
    return score(right) - score(left);
  });
}

function pickVoice(): SpeechSynthesisVoice | null {
  const speech = getSpeech();
  if (!speech) return null;
  const available = speech.getVoices();
  // Voice lists can populate asynchronously after the page loads; re-rank whenever
  // the list size changes so a freshly arrived English voice replaces a cached null.
  if (cachedVoice === undefined || available.length !== cachedVoiceSnapshot) {
    const ranked = rankVoices(available);
    cachedVoice = ranked[0] ?? null;
    cachedVoiceSnapshot = available.length;
  }
  return cachedVoice;
}

export function cancelEnglishSpeech(): void {
  getSpeech()?.cancel();
}

export function speakEnglish(text: string, options: EnglishSpeechOptions = {}): boolean {
  const speech = getSpeech();
  if (!speech || typeof SpeechSynthesisUtterance === 'undefined') return false;
  // Mobile browsers require speak() to run in the click handler. Their voice
  // list may still be empty then; let the browser use its en-US default voice.
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US';
  utterance.rate = options.rate ?? 1;
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  if (options.onend) utterance.onend = options.onend;
  if (options.onerror) utterance.onerror = options.onerror;
  speech.speak(utterance);
  return true;
}
