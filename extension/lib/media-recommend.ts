import type {
  MediaCorpusRecommendInput,
  MediaCorpusRecommendResponse,
  MediaCorpusRecommendation,
} from '@shadow-language/contracts';
import { unwrapRuntimeResponse } from './runtime-errors';

/** 一屏显示几条。服务端也返回 fitCount，这里只是兜底。 */
export const RECOMMEND_WINDOW_SIZE = 5;

export type RecommendKind = 'video' | 'audio';

/**
 * 阶梯上"一档"的标识：整数难度档（5.0–5.9 一档），音频视频同一套规则。
 *
 * 一档就是用户眼里的一个台阶，「更难」是上一档、「更简单」是下一档。
 *
 * 这里的算法必须和服务端切档（`buildLevelLadder`）完全一致：客户端要靠它自己
 * 算出档位边界来滑动窗口，两边不一致，窗口就会错位。
 */
export function levelKey(entry: MediaCorpusRecommendation): string {
  return String(Math.floor(entry.difficulty));
}

/**
 * 阶梯按档分段，返回每一档的起始下标。
 *
 * 同档的条目可能成百上千（ListenLeap 的分是整数，音频里光 5.1 就一大把），
 * 按条目逐条滑的话点一次「更难」看到的还是同一个分，像没动；按档滑才是台阶。
 */
export function levelStarts(ladder: MediaCorpusRecommendation[]): number[] {
  const starts: number[] = [];
  let previous: string | null = null;
  ladder.forEach((entry, index) => {
    const key = levelKey(entry);
    if (key !== previous) { starts.push(index); previous = key; }
  });
  return starts;
}

/**
 * 推荐卡的播放链接。
 *
 * 音频必须带 kind=audio：否则播放器在加载完成前会先按视频布局闪一下，
 * 音频语料是有画面的那个假舞台。链接本身按 web/src/media-corpus.tsx 的
 * mediaRoute 同样的写法：整段 `media:<id>` 一起编码，路由解析时再解开。
 */
export function recommendMediaRoute(item: MediaCorpusRecommendation): string {
  const query = item.mediaKind === 'audio' ? '?kind=audio' : '';
  return `#watch/${encodeURIComponent(`media:${item.id}`)}${query}`;
}

/**
 * 取一条难度阶梯。
 *
 * 阶梯是按难度升序排的：客户端把窗口往上挪就是"更难"，往下挪就是"更简单"，
 * 显示出来的数字单调变化，用户一眼能看出自己在往哪边走。
 */
export async function fetchDifficultyLadder(
  kind: RecommendKind,
  vocabularySize: number | undefined,
): Promise<MediaCorpusRecommendResponse | null> {
  const filters: MediaCorpusRecommendInput = {
    mediaKind: kind,
    ...(typeof vocabularySize === 'number' ? { vocabularySize } : {}),
  };
  try {
    const response = unwrapRuntimeResponse(await browser.runtime.sendMessage({
      type: 'MEDIA_CORPUS_RECOMMEND',
      filters,
    })) as MediaCorpusRecommendResponse;
    return response && Array.isArray(response.ladder) ? response : null;
  } catch {
    return null;
  }
}

/**
 * 取当前条目附近的一段难度阶梯（播放页的「换更难/换更简单」）。
 *
 * 服务端返回的是整条阶梯，客户端自己找相邻的那一档——为了一颗按钮跑两次请求不划算，
 * 而且两次之间语料库可能已经变了。
 *
 * 找不到就返回 null：宁可不给入口，也不给一个不相干的跳转。
 */
export async function fetchNearbyLadder(
  kind: RecommendKind,
  currentId: string,
  vocabularySize: number | undefined,
): Promise<MediaCorpusRecommendResponse | null> {
  const filters: MediaCorpusRecommendInput = {
    mediaKind: kind,
    mode: 'nearby',
    currentId,
    ...(typeof vocabularySize === 'number' ? { vocabularySize } : {}),
  };
  try {
    const response = unwrapRuntimeResponse(await browser.runtime.sendMessage({
      type: 'MEDIA_CORPUS_RECOMMEND',
      filters,
    })) as MediaCorpusRecommendResponse;
    return response && Array.isArray(response.ladder) ? response : null;
  } catch {
    return null;
  }
}

/**
 * 取窗口里的那几条。
 *
 * 窗口 = 当前那一档的条目。语料最难的几个档常常只有一两条（视频难度 10 只有 1 条），
 * 凑不满一屏：先往后（更难）借，还不够再往前（更简单）借——
 * 「推荐 5 个」不能因为档尾语料少就只给一张卡。阶梯按难度升序，借来的条目
 * 放回原位后数字仍然单调。
 */
export function recommendationWindow(
  response: MediaCorpusRecommendResponse | null,
  offset: number,
): MediaCorpusRecommendation[] {
  if (!response || !Array.isArray(response.ladder) || !response.ladder.length) return [];
  const ladder = response.ladder;
  const size = response.fitCount || RECOMMEND_WINDOW_SIZE;
  const start = Math.max(0, Math.min(ladder.length - 1, offset));
  const window = ladder.slice(start, start + size);
  if (window.length >= size) return window;
  for (let cursor = start + window.length; cursor < ladder.length && window.length < size; cursor += 1) {
    const item = ladder[cursor];
    if (item) window.push(item);
  }
  for (let cursor = start - 1; cursor >= 0 && window.length < size; cursor -= 1) {
    const item = ladder[cursor];
    if (item) window.unshift(item);
  }
  return window;
}

/** 当前窗口落在哪一档（返回该档的起始下标）。 */
function currentLevelStart(ladder: MediaCorpusRecommendation[], offset: number): number {
  const starts = levelStarts(ladder);
  let current = starts[0] ?? 0;
  for (const start of starts) {
    if (start <= offset) current = start;
    else break;
  }
  return current;
}

/**
 * 把窗口整体挪一档：往"更难"或"更简单"方向。
 *
 * 到顶/到底就停在原地——到底了就没有更简单/更难的东西，不该给一个跳回原处的假动作。
 */
export function shiftRecommendationWindow(
  response: MediaCorpusRecommendResponse | null,
  offset: number,
  direction: 'easier' | 'harder',
): number {
  if (!response || !Array.isArray(response.ladder) || !response.ladder.length) return 0;
  const starts = levelStarts(response.ladder);
  if (!starts.length) return 0;
  const current = currentLevelStart(response.ladder, offset);
  if (direction === 'harder') {
    for (const start of starts) if (start > current) return start;
    return current;
  }
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const start = starts[index];
    if (start !== undefined && start < current) return start;
  }
  return current;
}

/** 窗口还能不能再往这个方向挪一档。 */
export function canShiftWindow(
  response: MediaCorpusRecommendResponse | null,
  offset: number,
  direction: 'easier' | 'harder',
): boolean {
  if (!response || !Array.isArray(response.ladder) || !response.ladder.length) return false;
  const starts = levelStarts(response.ladder);
  if (!starts.length) return false;
  const current = currentLevelStart(response.ladder, offset);
  if (direction === 'harder') return starts.some((start) => start > current);
  return starts.some((start) => start < current);
}

/**
 * 从阶梯里取出相邻那一档的第一条（播放页的「换更难/换更简单」）。
 *
 * 阶梯按档排，所以「更难」是上一档的第一条、「更简单」是下一档的第一条——
 * 两个方向都取档首，和服务端口径一致，用户点之前就能在按钮上看到目标难度。
 * 到顶/到底时返回 null——不给一个跳回原处的假动作。
 */
export function neighborRecommendation(
  response: MediaCorpusRecommendResponse | null,
  currentId: string,
  direction: 'easier' | 'harder',
): MediaCorpusRecommendation | null {
  if (!response || !Array.isArray(response.ladder) || !response.ladder.length) return null;
  const ladder = response.ladder;
  const index = ladder.findIndex((entry) => entry.id === currentId);
  const current = index < 0 ? undefined : ladder[index];
  if (!current) return null;
  const key = levelKey(current);
  if (direction === 'harder') {
    for (let cursor = index + 1; cursor < ladder.length; cursor += 1) {
      const candidate = ladder[cursor];
      if (candidate && levelKey(candidate) !== key) return candidate;
    }
    return null;
  }
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = ladder[cursor];
    if (!candidate || levelKey(candidate) === key) continue;
    // 走到隔壁档的末尾了，回到那一档的第一个条目。
    let start = cursor;
    const neighborKey = levelKey(candidate);
    while (start > 0) {
      const previous = ladder[start - 1];
      if (!previous || levelKey(previous) !== neighborKey) break;
      start -= 1;
    }
    return ladder[start] ?? null;
  }
  return null;
}
