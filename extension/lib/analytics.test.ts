import { expect, it, vi } from 'vitest';
vi.mock('./constants',()=>({EXTENSION_VERSION:'test'}));
it('uses the background sink for background events instead of sending messages to itself',async()=>{vi.resetModules();const sendMessage=vi.fn(async()=>({}));vi.stubGlobal('browser',{runtime:{sendMessage}});const {track,configureAnalyticsSink}=await import('./analytics');track({name:'open'});expect(sendMessage).toHaveBeenCalledTimes(1);const sink=vi.fn();configureAnalyticsSink(sink);track({name:'feature'});expect(sink).toHaveBeenCalledWith({name:'feature'});expect(sendMessage).toHaveBeenCalledTimes(1);});

it('does not throw during player cleanup when the extension context has expired', async () => {
  vi.resetModules();
  vi.stubGlobal('browser', { runtime: { sendMessage: () => { throw new Error('Extension context invalidated.'); } } });
  const { track } = await import('./analytics');
  expect(() => track({ name: 'open' })).not.toThrow();
  await Promise.resolve();
});
