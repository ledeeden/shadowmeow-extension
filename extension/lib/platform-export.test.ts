import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadPlatformFile } from './platform-export';

describe('shared exports in the native host', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('delivers the original bytes to iOS and propagates dismissal without a browser download', async () => {
    const hook = vi.fn().mockResolvedValue('cancelled');
    vi.stubGlobal('__shadowNativeExport', hook);
    const content = new Blob(['我的学习笔记 🌏'], { type: 'text/markdown;charset=utf-8' });
    expect(await downloadPlatformFile(content, '学习.md', '学习笔记')).toBe('cancelled');
    expect(hook).toHaveBeenCalledWith(content, '学习.md', '学习笔记');
    expect(await (hook.mock.calls[0]![0] as Blob).text()).toBe('我的学习笔记 🌏');
  });
  it('lets the calling screen report native storage or share errors', async () => {
    vi.stubGlobal('__shadowNativeExport', vi.fn().mockRejectedValue(new Error('Storage full')));
    await expect(downloadPlatformFile(new Blob(['{}']), 'backup.json')).rejects.toThrow('Storage full');
  });
});
