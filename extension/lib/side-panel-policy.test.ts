import { describe, expect, it } from 'vitest';
import { isSidePanelLearningUrl } from './side-panel-policy';

describe('side panel page policy', () => {
  it.each([
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ&t=20s',
    'https://www.bilibili.com/video/BV1xx411c7mD/',
    'https://www.bilibili.com/bangumi/play/ep123456',
    'https://www.bilibili.com/bangumi/play/ss12345',
  ])('allows an explicit contextual panel on a supported video page: %s', (url) => {
    expect(isSidePanelLearningUrl(url)).toBe(true);
  });

  it.each([
    'chrome-extension://abcdefghijklmnop/dashboard.html#agent',
    'chrome-extension://abcdefghijklmnop/dashboard.html#study',
    'chrome-extension://abcdefghijklmnop/agent.html',
    'https://www.youtube.com/',
    'https://www.youtube.com/feed/subscriptions',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.bilibili.com/',
    'https://example.com/watch?v=dQw4w9WgXcQ',
    'not a url',
  ])('does not expose the contextual panel on a non-learning surface: %s', (url) => {
    expect(isSidePanelLearningUrl(url)).toBe(false);
  });
});
