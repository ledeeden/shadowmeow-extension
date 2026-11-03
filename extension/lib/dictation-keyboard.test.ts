import { describe, expect, it } from 'vitest';
import { isExternalDictationKey, showDictationPortraitHint } from './dictation-keyboard';

const key = { key: 'a', code: 'KeyA', isTrusted: true, isComposing: false, keyCode: 65 };

describe('iPad dictation keyboard inference and portrait hint', () => {
  it('recognizes real keys only when the software keyboard is absent', () => {
    expect(isExternalDictationKey(key, false)).toBe(true);
    expect(isExternalDictationKey({ ...key, key: 'Shift', code: 'ShiftLeft', keyCode: 16 }, false)).toBe(true);
    expect(isExternalDictationKey(key, true)).toBe(false);
  });
  it('does not infer a keyboard from synthetic, IME or unidentified input', () => {
    for (const patch of [
      { isTrusted: false }, { isComposing: true }, { keyCode: 229 },
      { code: '' }, { code: 'Unidentified' }, { key: 'Unidentified' }, { key: 'Process' },
    ]) expect(isExternalDictationKey({ ...key, ...patch }, false)).toBe(false);
    expect(isExternalDictationKey({ ...key, key: 'Escape', code: 'Escape' }, false)).toBe(false);
  });
  it('hides the landscape hint after keyboard detection and restores it when software input resumes', () => {
    expect(showDictationPortraitHint(true, false, false)).toBe(true);
    expect(showDictationPortraitHint(true, true, false)).toBe(false);
    expect(showDictationPortraitHint(true, false, false)).toBe(true);
    expect(showDictationPortraitHint(false, false, false)).toBe(false);
  });
  it('allows manual dismissal even without keyboard detection, including after rotating again', () => {
    expect(showDictationPortraitHint(true, false, true)).toBe(false);
    expect(showDictationPortraitHint(false, false, true)).toBe(false);
    expect(showDictationPortraitHint(true, false, true)).toBe(false);
  });
});
