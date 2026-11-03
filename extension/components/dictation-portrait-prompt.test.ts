import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DictationPortraitPrompt } from './dictation-portrait-prompt';

describe('Web dictation portrait suggestion', () => {
  it('offers keyboard detection guidance and a dismiss button without closing dictation', () => {
    const html = renderToStaticMarkup(React.createElement(DictationPortraitPrompt, { onDismiss: () => undefined }));
    expect(html).toContain('建议使用竖屏听写');
    expect(html).toContain('按任意键即可继续');
    expect(html).toContain('关闭提示，横屏继续</button>');
    expect(html).not.toContain('关闭逐句听写');
  });
  it('preserves the existing prompt for callers without a dismiss action', () => {
    const html = renderToStaticMarkup(React.createElement(DictationPortraitPrompt));
    expect(html).toContain('请将 iPad 竖过来');
    expect(html).not.toContain('<button');
  });
});
