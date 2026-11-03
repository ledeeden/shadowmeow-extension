import { describe, expect, it } from 'vitest';
import type { PageState } from '@shadow-language/contracts';
import { learningTools } from './runtime';
import { buildAgentNoteReference, explicitlyRequestsNoteOverwrite, explicitlyRequestsNoteSave, noteOverwriteToken, parseAgentNoteInput } from './note';

const page: PageState = {
  youtubeId: 'dQw4w9WgXcQ',
  title: 'Hotel English',
  channelTitle: 'Travel English',
  durationMs: 90_000,
  playerState: 'paused',
  timeMs: 12_000,
  playbackRate: 1,
  tracks: [],
  activeTrackId: '.en',
  cues: [
    { seq: 0, startMs: 1_000, endMs: 3_000, text: 'Welcome to our hotel.' },
    { seq: 1, startMs: 10_000, endMs: 13_000, text: 'I would like to check in, please.' },
  ],
  segments: [],
};

describe('Agent note writes', () => {
  it('exposes a structured note tool', () => {
    const tool = learningTools.find((candidate) => candidate.function.name === 'note_save');
    expect(tool?.function.parameters).toMatchObject({
      required: ['action', 'body'],
      properties: { action: { enum: ['create', 'append', 'overwrite'] } },
    });
  });

  it('requires an explicit request before allowing the model to write notes', () => {
    expect(explicitlyRequestsNoteSave('把这些内容加进笔记')).toBe(true);
    expect(explicitlyRequestsNoteSave('帮我整理成笔记')).toBe(true);
    expect(explicitlyRequestsNoteSave('Please save this into my notes')).toBe(true);
    expect(explicitlyRequestsNoteSave('解释一下这个表达的意思')).toBe(false);
    expect(explicitlyRequestsNoteSave('总结一下这段话')).toBe(false);
  });

  it('separates overwrite intent from ordinary note requests', () => {
    expect(explicitlyRequestsNoteOverwrite('把笔记正文重写一下')).toBe(true);
    expect(explicitlyRequestsNoteOverwrite('把这段内容写进笔记')).toBe(false);
  });

  it('turns a create request into a titled markdown body', () => {
    const parsed = parseAgentNoteInput({ action: 'create', title: '酒店入住', body: 'check in 是办理入住' });
    expect(parsed.body).toBe('# 酒店入住\n\ncheck in 是办理入住');
  });

  it('rejects incomplete writes instead of guessing', () => {
    expect(() => parseAgentNoteInput({ action: 'create', body: '没有标题' })).toThrow('标题');
    expect(() => parseAgentNoteInput({ action: 'append', body: '没有 ID' })).toThrow('笔记 ID');
    expect(() => parseAgentNoteInput({ action: 'delete', body: 'x' })).toThrow('新建、追加或重写');
    expect(() => parseAgentNoteInput({ action: 'create', title: 't', body: '   ' })).toThrow('不能为空');
  });

  it('anchors a note to the caption sentence its body quotes', () => {
    const parsed = parseAgentNoteInput({ action: 'create', title: '入住', body: 'I would like to check in, please. 表示想办理入住' });
    const reference = buildAgentNoteReference(parsed, page);
    expect(reference).toMatchObject({
      videoKey: 'dQw4w9WgXcQ',
      title: 'Hotel English',
      text: 'I would like to check in, please.',
      startMs: 10_000,
      endMs: 13_000,
    });
    expect(reference.url).toContain('youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('keeps self-hosted audio anchored instead of rejecting the media key', () => {
    const mediaPage: PageState = { ...page, youtubeId: null, platform: 'media', videoKey: 'media:englishpod-b001', mediaKind: 'audio' };
    const parsed = parseAgentNoteInput({ action: 'create', title: '听力笔记', body: 'I would like to check in, please.' });
    const reference = buildAgentNoteReference(parsed, mediaPage);
    expect(reference.videoKey).toBe('media:englishpod-b001');
    expect(reference.startMs).toBe(10_000);
  });

  it('falls back to the detached bucket when there is no corpus at all', () => {
    const parsed = parseAgentNoteInput({ action: 'create', title: '今天记的', body: '打扫公寓花了 48 小时' });
    const reference = buildAgentNoteReference(parsed, undefined);
    expect(reference).toMatchObject({ videoKey: 'general', title: '今天记的', text: '今天记的', url: '', startMs: 0 });
  });

  it('invalidates a confirmation token once the note changed underneath it', () => {
    const note = { id: 'note_1', body: '第一版正文', updatedAt: 1000 };
    const token = noteOverwriteToken(note);
    expect(noteOverwriteToken(note)).toBe(token);
    expect(noteOverwriteToken({ ...note, body: '第二版正文' })).not.toBe(token);
    expect(noteOverwriteToken({ ...note, updatedAt: 2000 })).not.toBe(token);
  });
});
