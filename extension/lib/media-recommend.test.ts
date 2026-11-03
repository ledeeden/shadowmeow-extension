import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { MediaCorpusRecommendResponse, MediaCorpusRecommendation } from '@shadow-language/contracts';
import {
  canShiftWindow,
  fetchDifficultyLadder,
  fetchNearbyLadder,
  levelKey,
  levelStarts,
  neighborRecommendation,
  recommendationWindow,
  recommendMediaRoute,
  shiftRecommendationWindow,
} from './media-recommend';

function entry(id: string, difficulty: number, sourceLevel: string | null = null): MediaCorpusRecommendation {
  return {
    id,
    title: id,
    titleZh: '',
    thumbnailUrl: null,
    durationMs: 60_000,
    seriesTitle: null,
    mediaKind: sourceLevel ? 'audio' : 'video',
    difficulty,
    method: sourceLevel ? 'listenleap-score-v1' : 'vocabulary-demand-v1',
    sourceLevel,
  };
}

function response(entries: MediaCorpusRecommendation[], fitStart = 0, fitCount = 5): MediaCorpusRecommendResponse {
  return {
    version: 'difficulty-v1',
    // 客户端按响应里的 kind 算档位,和服务端切档同一口径。
    kind: entries.some((entry) => entry.sourceLevel) ? 'audio' : 'video',
    band: 'B1',
    target: 6,
    ladder: entries,
    fitStart,
    fitCount,
    levelStats: [{ level: 'B1', count: entries.length, median: 5 }],
  };
}

let send: ReturnType<typeof vi.fn>;

beforeEach(() => {
  send = vi.fn(async () => response([entry('a', 1), entry('b', 2)]));
  vi.stubGlobal('browser', { runtime: { sendMessage: send } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('推荐窗口', () => {
  it('按 fitCount 取出窗口里的一屏', () => {
    const ladder = Array.from({ length: 12 }, (_, index) => entry(`e${index}`, index));
    expect(recommendationWindow(response(ladder), 3).map((item) => item.id)).toEqual(['e3', 'e4', 'e5', 'e6', 'e7']);
  });

  it('越界时贴着边界取，不会返回空数组', () => {
    const ladder = Array.from({ length: 12 }, (_, index) => entry(`e${index}`, index));
    expect(recommendationWindow(response(ladder), 99).map((item) => item.id)).toEqual(['e7', 'e8', 'e9', 'e10', 'e11']);
    expect(recommendationWindow(response(ladder), -4).map((item) => item.id)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });

  it('没有阶梯就没有推荐', () => {
    expect(recommendationWindow(null, 0)).toEqual([]);
    expect(recommendationWindow(response([]), 0)).toEqual([]);
  });

  it('档尾语料少时也凑满一屏,不够就往更简单的一侧借', () => {
    // 最后一档只有 1 条（视频难度 10 就只有 1 条），不能只给用户一张卡。
    const ladder = [entry('d8-0', 8.8), entry('d8-1', 8.8), entry('d8-2', 8.8), entry('d9-0', 9.3), entry('d10-0', 10)];
    const window = recommendationWindow(response(ladder), 4);
    expect(window).toHaveLength(5);
    expect(window.map((item) => item.id)).toEqual(['d8-0', 'd8-1', 'd8-2', 'd9-0', 'd10-0']);
    // 借来的条目按难度升序放回原位，数字仍然单调。
    expect(window.map((item) => item.difficulty)).toEqual([8.8, 8.8, 8.8, 9.3, 10]);
  });
});

describe('整组换档', () => {
  it('视频：难度值不同就是不同的一档', () => {
    const ladder = Array.from({ length: 12 }, (_, index) => entry(`e${index}`, index));
    const base = response(ladder);
    expect(levelStarts(ladder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(shiftRecommendationWindow(base, 0, 'harder')).toBe(1);
    expect(shiftRecommendationWindow(base, 1, 'easier')).toBe(0);
  });

  it('同一难度档的条目再多也只算一档,换档是跨到下一个难度档', () => {
    // 五个 5.1 加一个 6.5:点一次「更难」要直接跨到 6 那一档,而不是同档的下一条。
    const ladder = [
      entry('d5-0', 5.1), entry('d5-1', 5.1), entry('d5-2', 5.1),
      entry('d5-3', 5.1), entry('d5-4', 5.1), entry('d6-0', 6.5),
    ];
    const base = response(ladder);
    expect(levelStarts(ladder)).toEqual([0, 5]);
    expect(shiftRecommendationWindow(base, 0, 'harder')).toBe(5);
    expect(shiftRecommendationWindow(base, 5, 'easier')).toBe(0);
  });

  it('到顶/到底就停住，不给跳回原处的假动作', () => {
    const ladder = Array.from({ length: 4 }, (_, index) => entry(`e${index}`, index));
    const base = response(ladder);
    expect(shiftRecommendationWindow(base, 0, 'easier')).toBe(0);
    expect(shiftRecommendationWindow(base, 3, 'harder')).toBe(3);
    expect(canShiftWindow(base, 0, 'easier')).toBe(false);
    expect(canShiftWindow(base, 0, 'harder')).toBe(true);
    expect(canShiftWindow(base, 3, 'harder')).toBe(false);
    expect(canShiftWindow(base, 3, 'easier')).toBe(true);
  });
});

describe('播放页的邻近语料', () => {
  it('更难是上一档的第一条,更简单是下一档的第一条', () => {
    const ladder = [
      entry('d4-0', 4.5), entry('d4-1', 4.6),
      entry('d5-0', 5.1), entry('d5-1', 5.2),
      entry('d6-0', 6.5),
    ];
    expect(neighborRecommendation(response(ladder), 'd5-0', 'easier')?.id).toBe('d4-0');
    expect(neighborRecommendation(response(ladder), 'd5-0', 'harder')?.id).toBe('d6-0');
  });

  it('到顶或到底就没有邻居——宁可不给入口', () => {
    const ladder = [entry('d5-0', 5.1), entry('d6-0', 6.5)];
    expect(neighborRecommendation(response(ladder), 'd5-0', 'easier')).toBeNull();
    expect(neighborRecommendation(response(ladder), 'd6-0', 'harder')).toBeNull();
  });

  it('当前条目不在窗口里就当没有邻居', () => {
    expect(neighborRecommendation(response([entry('a', 1)]), 'missing', 'harder')).toBeNull();
    expect(neighborRecommendation(null, 'a', 'harder')).toBeNull();
  });
});

describe('推荐请求', () => {
  it('带上语料类型和词表档位去要一条阶梯', async () => {
    await fetchDifficultyLadder('audio', 3000);
    expect(send).toHaveBeenCalledWith({
      type: 'MEDIA_CORPUS_RECOMMEND',
      filters: { mediaKind: 'audio', vocabularySize: 3000 },
    });
  });

  it('没有词表档位时不传这个字段', async () => {
    await fetchDifficultyLadder('video', undefined);
    expect(send).toHaveBeenCalledWith({
      type: 'MEDIA_CORPUS_RECOMMEND',
      filters: { mediaKind: 'video' },
    });
  });

  it('播放页一次要回整条阶梯，两个方向自己算', async () => {
    await fetchNearbyLadder('video', 'item-1', 3000);
    expect(send).toHaveBeenCalledWith({
      type: 'MEDIA_CORPUS_RECOMMEND',
      filters: { mediaKind: 'video', mode: 'nearby', currentId: 'item-1', vocabularySize: 3000 },
    });
  });

  it('服务不可用时返回 null，页面照常打开', async () => {
    send.mockRejectedValue(new Error('服务不可用'));
    expect(await fetchDifficultyLadder('video', 3000)).toBeNull();
    expect(await fetchNearbyLadder('video', 'item-1', 3000)).toBeNull();
  });

  it('服务回了错误信封时也不抛给页面', async () => {
    send.mockResolvedValueOnce({ __shadowLanguageError: { message: '出错了' } });
    expect(await fetchDifficultyLadder('video', 3000)).toBeNull();
  });
});

describe('推荐卡的播放链接', () => {
  it('音频带 kind=audio,不然播放器加载前会先按视频布局闪一下', () => {
    expect(recommendMediaRoute(entry('ll-1801523589816651776-0047', 5.1, 'B1'))).toBe(
      `#watch/${encodeURIComponent('media:ll-1801523589816651776-0047')}?kind=audio`,
    );
  });

  it('视频不带 kind 参数', () => {
    expect(recommendMediaRoute(entry('youtube-mgfBmnD04Q8', 4.6))).toBe(
      `#watch/${encodeURIComponent('media:youtube-mgfBmnD04Q8')}`,
    );
  });

  it('链接解开后就是路由认得的 media:<id>', () => {
    const href = recommendMediaRoute(entry('ll-1801523589816651776-0047', 5.1, 'B1'));
    const encoded = href.slice('#watch/'.length).split('?')[0] ?? '';
    expect(decodeURIComponent(encoded)).toBe('media:ll-1801523589816651776-0047');
  });
});

describe('客户端与服务端切档口径一致', () => {
  const require = createRequire(import.meta.url);
  const { buildLevelLadder } = require('../../cloudbase/functions/shadowLanguageApi/lib/corpus-difficulty');

  const entries = [
    { id: 'a', difficulty: 5.1, sourceLevel: 'B1', method: 'listenleap-score-v1' },
    { id: 'b', difficulty: 5.2, sourceLevel: 'B1', method: 'listenleap-score-v1' },
    { id: 'c', difficulty: 5.4, sourceLevel: 'B2', method: 'listenleap-score-v1' },
    { id: 'd', difficulty: 4.6, sourceLevel: null, method: 'vocabulary-demand-v1' },
    { id: 'e', difficulty: 4.9, sourceLevel: null, method: 'vocabulary-demand-v1' },
    { id: 'f', difficulty: 6.5, sourceLevel: 'C1', method: 'listenleap-score-v1' },
  ];

  it('客户端算出的档位边界和服务端切出来的一致', () => {
    // 两边不一致，客户端滑动窗口就会错位：按 5 条一屏挪，但服务端的档是 2 条、1 条、2 条。
    const levels = buildLevelLadder(entries, { fitCount: 5 });
    expect(levelStarts(levels.ladder as MediaCorpusRecommendation[])).toEqual(levels.levels.map((level: { start: number }) => level.start));
  });

  it('档位键是整数难度档,不管条目带不带来源档位', () => {
    const levels = buildLevelLadder(entries, { fitCount: 5 });
    const orphan = levels.ladder.find((entry: { id: string }) => entry.id === 'd');
    expect(levelKey(orphan as MediaCorpusRecommendation)).toBe('4');
    // 没有来源档位的条目不单独成档,和同档难度的另一条在一起。
    expect(levels.levels.find((level: { key: string }) => level.key === '4')?.count).toBe(2);
  });
});
