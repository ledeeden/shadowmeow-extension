import { describe,it,expect } from 'vitest';
import { BILIBILI_AUTO_RETRY_LIMIT, biliKey, nativeBiliCues, nextBilibiliRetry, subtitleCdnUrl, videoDurationMs } from './bilibili';
import { dedupeCorpusEntries } from './corpus';
describe('Bilibili adapter boundaries',()=>{
 it('uses cid to distinguish video editions and parts',()=>{
  const info={epId:'4173750',bvid:'BV1xU7f6xEFo',aid:'116690939547176',cid:'38850857680',title:'Test'};
  expect(biliKey(info)).toBe('bilibili:ep:4173750:cid:38850857680');
  expect(biliKey({...info,cid:'123'})).not.toBe(biliKey(info));
 });
 it('normalizes native subtitle timing and rejects non-CDN sources',()=>{
  expect(nativeBiliCues([{from:1.25,to:2.5,content:'98.'}])).toEqual([{seq:0,startMs:1250,endMs:2500,text:'98.'}]);
  expect(subtitleCdnUrl('//aisubtitle.hdslb.com/test.json')).toBe('https://aisubtitle.hdslb.com/test.json');
  for(const url of ['https://evil.com/sub','https://hdslb.com.evil.com/sub','http://aisubtitle.hdslb.com/sub']) expect(()=>subtitleCdnUrl(url)).toThrow();
 });
 it('does not treat an unready or invalid media duration as a requestable duration',()=>{
  expect(videoDurationMs(null)).toBe(0);
  expect(videoDurationMs({duration:0} as HTMLVideoElement)).toBe(0);
  expect(videoDurationMs({duration:Number.NaN} as HTMLVideoElement)).toBe(0);
  expect(videoDurationMs({duration:1084.25} as HTMLVideoElement)).toBe(1084250);
 });
 it('caps automatic CloudBase subtitle retries after exponential backoff',()=>{
  const first=nextBilibiliRetry(0,1000), second=nextBilibiliRetry(first.attempts,1000), third=nextBilibiliRetry(second.attempts,1000);
  expect([first.attempts,second.attempts,third.attempts]).toEqual([1,2,3]);
  expect([first.retryAt,second.retryAt,third.retryAt]).toEqual([6000,11000,21000]);
  expect(third.attempts < BILIBILI_AUTO_RETRY_LIMIT).toBe(false);
 });
  it('does not collapse unrelated Bilibili watch history under missing youtubeId',()=>{
  const entries=[{videoKey:'bilibili:ep:1:cid:2',positionMs:1000,status:'watched'},{videoKey:'bilibili:ep:2:cid:3',positionMs:2000,status:'watched'},{youtubeId:'dQw4w9WgXcQ',status:'watched'}];
  expect(dedupeCorpusEntries(entries)).toHaveLength(3);
 });
});
