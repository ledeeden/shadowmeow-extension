import { afterEach, describe, expect, it, vi } from 'vitest';
import { speakEnglish } from './speech';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('English pronunciation', () => {
  it('speaks in the same user gesture even before voices are listed', () => {
    const speak = vi.fn();
    vi.stubGlobal('window', { speechSynthesis: { getVoices: () => [], speak } });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = '';
      rate = 1;
      constructor(public text: string) {}
    });

    expect(speakEnglish('14-year-old', { rate: 0.82 })).toBe(true);
    expect(speak).toHaveBeenCalledOnce();
    expect(speak.mock.calls[0]?.[0]).toMatchObject({ text: '14-year-old', lang: 'en-US', rate: 0.82 });
  });

  it('selects an available English voice without delaying playback', () => {
    const voice = { name: 'Samantha', lang: 'en-US', localService: true } as SpeechSynthesisVoice;
    const speak = vi.fn();
    vi.stubGlobal('window', { speechSynthesis: { getVoices: () => [voice], speak } });
    vi.stubGlobal('SpeechSynthesisUtterance', class {
      lang = '';
      rate = 1;
      voice: SpeechSynthesisVoice | null = null;
      constructor(public text: string) {}
    });

    expect(speakEnglish('ready')).toBe(true);
    expect(speak).toHaveBeenCalledOnce();
    expect(speak.mock.calls[0]?.[0]).toMatchObject({ text: 'ready', voice });
  });
});
