import { z } from 'zod';
import { bilibiliVideoKeySchema } from './video';
import type { CaptionCue } from './api';

const subtitleCueSchema = z.object({
  id: z.string().min(1).max(128),
  startMs: z.number().int().min(0).max(86_400_000),
  endMs: z.number().int().positive().max(86_400_000),
  text: z.string().min(1).max(2000),
}).refine(cue => cue.endMs > cue.startMs);

export const subtitlePackageSchema = z.object({
  schemaVersion: z.literal('sl-subtitle-package/1'),
  assetId: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  title: z.string().min(1).max(300),
  attribution: z.string().max(1000),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  tracks: z.array(z.object({
    language: z.enum(['en', 'zh-Hans']),
    cues: z.array(subtitleCueSchema).min(1).max(20_000),
  })).min(1).max(2),
}).superRefine((value, ctx) => {
  if (new Set(value.tracks.map(track => track.language)).size !== value.tracks.length) ctx.addIssue({ code: 'custom', message: 'Duplicate language' });
  for (const track of value.tracks) {
    if (new Set(track.cues.map(cue => cue.id)).size !== track.cues.length) ctx.addIssue({ code: 'custom', message: 'Duplicate cue id' });
    if (track.cues.some((cue, i) => i > 0 && cue.startMs < track.cues[i - 1]!.startMs)) ctx.addIssue({ code: 'custom', message: 'Unsorted cues' });
  }
});

export const subtitleBindingSchema = z.object({
  videoKey: bilibiliVideoKeySchema,
  revision: z.number().int().positive(),
  durationMs: z.number().int().positive().max(86_400_000),
  offsetMs: z.number().int().min(-600_000).max(600_000),
  scale: z.number().min(0.5).max(2),
  mask: z.object({
    bottom: z.number().min(0).max(45), height: z.number().min(3).max(40),
    // Extra hard-coded annotations use the bound video's clock, not subtitle cue time.
    annotations: z.array(z.object({
      startMs: z.number().int().min(0).max(86_400_000), endMs: z.number().int().positive().max(86_400_000),
      bottom: z.number().min(0).max(97), height: z.number().min(3).max(40),
    }).refine(region => region.endMs > region.startMs && region.bottom + region.height <= 100)).max(100).optional(),
  }),
});

export const subtitleResolutionSchema = z.object({
  status: z.literal('available'),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  binding: subtitleBindingSchema,
  package: subtitlePackageSchema,
});
export type SubtitleResolution = z.infer<typeof subtitleResolutionSchema>;
export type SubtitlePackage = z.infer<typeof subtitlePackageSchema>;
export type SubtitleBinding = z.infer<typeof subtitleBindingSchema>;

export function mappedSubtitleCues(value: SubtitleResolution, language: 'en' | 'zh-Hans'): CaptionCue[] {
  const track = value.package.tracks.find(item => item.language === language);
  return (track?.cues || []).map((cue, seq) => ({ seq, text: cue.text,
    startMs: Math.max(0, Math.round(cue.startMs * value.binding.scale + value.binding.offsetMs)),
    endMs: Math.max(1, Math.round(cue.endMs * value.binding.scale + value.binding.offsetMs)),
  })).filter(cue => cue.endMs > cue.startMs);
}

export function translatedSegmentText(cues: CaptionCue[], segment: { startMs: number; endMs: number } | null): string {
  if (!segment) return '';
  return cues.filter(cue => cue.startMs < segment.endMs && cue.endMs > segment.startMs).map(cue => cue.text).join(' ');
}
