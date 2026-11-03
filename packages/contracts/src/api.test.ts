import { describe, expect, it } from 'vitest';
import { ACTIONS, attemptSchema, clientSchema, progressSchema, savedItemSchema, settingsSchema } from './api';

const youtubeId = 'dQw4w9WgXcQ';
const occurredAt = '2026-09-03T03:10:00.000Z';

describe('learning API contracts', () => {
  it('distinguishes Web clients while keeping older extension envelopes compatible', () => {
    expect(clientSchema.parse({ extensionVersion: '0.1.3', adapterVersion: 'test', deviceId: 'device-client-001' }).clientType).toBe('extension');
    expect(clientSchema.parse({ clientType: 'web', extensionVersion: '0.1.3', adapterVersion: 'test', deviceId: 'device-client-001' }).clientType).toBe('web');
  });

  it('exposes separate actions for self-hosted media corpus reads', () => {
    expect(ACTIONS).toContain('mediaCorpus.publicList');
    expect(ACTIONS).toContain('mediaCorpus.resolvePlayback');
    expect(ACTIONS).toContain('mediaCorpus.recommend');
  });
  it('exposes separate lightweight subtitle title and detail actions', () => {
    expect(ACTIONS).toContain('corpus.listSubtitleTitles');
    expect(ACTIONS).toContain('corpus.getSubtitleDetail');
  });
  it('exposes the authenticated centralized AI action', () => {
    expect(ACTIONS).toContain('ai.complete');
  });
  it('accepts native short YouTube caption track IDs', () => {
    expect(progressSchema.parse({
      youtubeId,
      trackId: '.en',
      segmentSeq: 0,
      positionMs: 1000,
      completedRatio: 0.1,
      occurredAt,
    }).trackId).toBe('.en');

    expect(attemptSchema.parse({
      id: 'attempt-client-001',
      youtubeId,
      trackId: 'a.en',
      segmentSeq: 0,
      startMs: 0,
      endMs: 1000,
      mode: 'manual',
      trigger: 'manual_replay',
      occurredAt,
    }).trackId).toBe('a.en');

    expect(savedItemSchema.parse({
      id: 'item-client-001',
      kind: 'word',
      normalizedValue: 'hello',
      displayValue: 'hello',
      youtubeId,
      trackId: '.en',
      segmentSeq: 0,
      startMs: 0,
      contextText: 'Hello.',
      occurredAt,
    }).trackId).toBe('.en');
  });

  it('persists the explicit vocabulary size with a safe default', () => {
    expect(settingsSchema.parse({}).vocabularySize).toBe(3_000);
    expect(settingsSchema.parse({ vocabularySize: 5_500 }).vocabularySize).toBe(5_500);
    expect(() => settingsSchema.parse({ vocabularySize: 10_001 })).toThrow();
  });

  it('defaults subtitle display to the full English line', () => {
    expect(settingsSchema.parse({}).playbackPreferences.subtitleDisplayMode).toBe('all');
    expect(settingsSchema.parse({ playbackPreferences: { subtitleDisplayMode: 'new-words' } }).playbackPreferences.subtitleDisplayMode).toBe('new-words');
  });

  it('accepts the full listening speed range', () => {
    expect(settingsSchema.parse({ playbackPreferences: { playbackRate: 0.4 } }).playbackPreferences.playbackRate).toBe(0.4);
    expect(settingsSchema.parse({ playbackPreferences: { playbackRate: 2 } }).playbackPreferences.playbackRate).toBe(2);
    expect(() => settingsSchema.parse({ playbackPreferences: { playbackRate: 0.39 } })).toThrow();
    expect(() => settingsSchema.parse({ playbackPreferences: { playbackRate: 2.01 } })).toThrow();
  });
});
