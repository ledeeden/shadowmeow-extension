import { describe,it,expect } from 'vitest';
import { mappedSubtitleCues,subtitlePackageSchema,subtitleBindingSchema,translatedSegmentText } from './subtitles';
import { videoIdentity,videoKeyOf,videoUrl,videoThumbnail } from './video';
import { progressSchema } from './api';
const pkg={schemaVersion:'sl-subtitle-package/1' as const,assetId:'fixture',revision:1,title:'Fixture',attribution:'Test',sourceHash:'a'.repeat(64),tracks:[{language:'en' as const,cues:[{id:'one',startMs:1000,endMs:2000,text:'98.'}]},{language:'zh-Hans' as const,cues:[{id:'one',startMs:1000,endMs:2000,text:'九十八。'}]}]};
describe('bilingual corpus contracts',()=>{
 it('validates timed annotation masks against frame geometry and video time',()=>{
  const binding={videoKey:'bilibili:ep:4173750:cid:38850857680',revision:1,durationMs:1278000,offsetMs:0,scale:1,mask:{bottom:5,height:19,annotations:[{startMs:1243080,endMs:1248180,bottom:78,height:22}]}};
  expect(subtitleBindingSchema.parse(binding).mask.annotations).toEqual(binding.mask.annotations);
  expect(subtitleBindingSchema.safeParse({...binding,mask:{...binding.mask,annotations:[{startMs:20,endMs:10,bottom:78,height:22}]}}).success).toBe(false);
  expect(subtitleBindingSchema.safeParse({...binding,mask:{...binding.mask,annotations:[{startMs:10,endMs:20,bottom:90,height:22}]}}).success).toBe(false);
 });
 it('maps both tracks with the same binding and preserves numeric speech',()=>{
  const result={status:'available' as const,contentHash:'a'.repeat(64),package:pkg,binding:{videoKey:'bilibili:ep:4173750:cid:38850857680',revision:1,durationMs:10000,offsetMs:500,scale:1.02,mask:{bottom:5,height:18}}};
  const en=mappedSubtitleCues(result,'en'),zh=mappedSubtitleCues(result,'zh-Hans');
  expect(en[0]).toMatchObject({startMs:1520,endMs:2540,text:'98.'});
  expect(translatedSegmentText(zh,en[0]!)).toBe('九十八。');
  expect(translatedSegmentText(zh,{startMs:2540,endMs:3000})).toBe('');
 });
 it('rejects duplicate languages, ids and invalid timing',()=>{
  expect(subtitlePackageSchema.safeParse({...pkg,tracks:[pkg.tracks[0],pkg.tracks[0]]}).success).toBe(false);
  expect(subtitlePackageSchema.safeParse({...pkg,tracks:[{...pkg.tracks[0],cues:[pkg.tracks[0]!.cues[0],pkg.tracks[0]!.cues[0]]}]}).success).toBe(false);
 });
 it('keeps YouTube and Bilibili identities separate and roundtrips links',()=>{
  expect(videoIdentity('dQw4w9WgXcQ')).toEqual({youtubeId:'dQw4w9WgXcQ'});
  const key='bilibili:ep:4173750:cid:38850857680';
  expect(videoKeyOf(videoIdentity(key))).toBe(key);
  expect(videoUrl(key,12500)).toContain('/ep4173750?t=12');
  expect(()=>videoIdentity('javascript:alert(1)')).toThrow();
  const progress={...videoIdentity(key),segmentSeq:0,positionMs:0,completedRatio:0,activeSecondsDelta:0,occurredAt:new Date().toISOString()};
  expect(progressSchema.safeParse(progress).success).toBe(true);
  expect(progressSchema.safeParse({...progress,youtubeId:'dQw4w9WgXcQ'}).success).toBe(false);
 });
 it('accepts self-hosted media keys used by the web player without treating them as YouTube progress ids',()=>{
  const key='media:youtube-d0yGdNEWdn0';
  expect(videoIdentity(key)).toEqual({videoKey:key});
  expect(videoKeyOf(videoIdentity(key))).toBe(key);
  expect(videoUrl(key,12500)).toBe('https://www.youtube.com/watch?v=d0yGdNEWdn0&t=12s');
  expect(videoThumbnail({videoKey:key})).toBe('https://i.ytimg.com/vi/d0yGdNEWdn0/hqdefault.jpg');
  expect(videoUrl('media:custom-asset-id')).toBe('');
  const cover='https://example.com/media-corpus/items/onboarding-foundation-v1/thumbnail/cover.jpg';
  expect(videoThumbnail({videoKey:'media:onboarding-foundation-v1',thumbnailUrl:cover})).toBe(cover);
  expect(videoThumbnail({videoKey:'media:onboarding-foundation-v1',thumbnailUrl:'https://example.com/media-corpus/items/onboarding-foundation-v1/thumbnail/cover.jpg'})).toBe('');
  expect(()=>videoIdentity('media:abc')).toThrow();
  expect(()=>videoIdentity('media:bad/id')).toThrow();
 });
});
