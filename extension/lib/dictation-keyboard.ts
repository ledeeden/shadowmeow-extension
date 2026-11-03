type DictationKey = Pick<KeyboardEvent, 'key' | 'code' | 'isTrusted' | 'isComposing' | 'keyCode'>;

// Virtual keys can also have a code. Combine real input with viewport evidence.
export function isExternalDictationKey(event: DictationKey, softwareKeyboardVisible: boolean): boolean {
  return !softwareKeyboardVisible && event.isTrusted && !event.isComposing
    && event.keyCode !== 229 && Boolean(event.code) && event.code !== 'Unidentified'
    && event.key !== 'Unidentified' && event.key !== 'Process' && event.key !== 'Escape';
}

export function showDictationPortraitHint(landscape: boolean, externalKeyboard: boolean, dismissed: boolean): boolean {
  return landscape && !externalKeyboard && !dismissed;
}
