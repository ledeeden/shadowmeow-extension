import { beforeEach, describe, expect, it, vi } from 'vitest';
import { completeModel } from './provider';
import { generateFollowUpQuestions, parseFollowUpQuestions } from './follow-up-questions';

vi.mock('./provider', () => ({ completeModel: vi.fn() }));
const input = () => ({ signal: new AbortController().signal,
  question: '怎么点拿铁？', context: '咖啡馆', messages: [
    { role: 'user' as const, content: '怎么点拿铁？' },
    { role: 'assistant' as const, content: 'Could I have a latte, please?' },
  ] });

describe('follow-up questions', () => {
  beforeEach(() => vi.resetAllMocks());
  it('uses the latest answer and context without enabling tools', async () => {
    const questions = ['怎么说少冰？', '怎么换燕麦奶？', '大杯怎么说？', '能帮我练习点单吗？', '这句怎么连读？'];
    vi.mocked(completeModel).mockResolvedValue({ role: 'assistant', content: JSON.stringify(questions) });
    expect(await generateFollowUpQuestions(input())).toEqual(questions.slice(0, 3));
    const call = vi.mocked(completeModel).mock.calls[0]![0];
    expect(call.messages[0]!.content).toContain('恰好 3 个');
    expect(call.messages[0]!.content).toContain('包含 3 个字符串');
    expect(call.messages[1]!.content).toContain('Could I have a latte');
    expect(call.messages[1]!.content).toContain('咖啡馆');
    expect(call.tools).toBeUndefined();
  });
  it('deduplicates and rejects malformed or overlong suggestions', () => {
    expect(parseFollowUpQuestions('```json\n[" 怎么点单？ ", "怎么点单？", null, ""]\n```')).toEqual(['怎么点单？']);
    expect(parseFollowUpQuestions(JSON.stringify(['a'.repeat(181)]))).toEqual([]);
    expect(parseFollowUpQuestions('not json')).toEqual([]);
  });
  it('fills incomplete model results to exactly three unique questions', async () => {
    vi.mocked(completeModel).mockResolvedValue({ role: 'assistant', content: '["怎么换燕麦奶？"]' });
    const result = await generateFollowUpQuestions(input());
    expect(new Set(result).size).toBe(3);
    expect(result[0]).toBe('怎么换燕麦奶？');
  });
  it('preserves the answer path when recommendations fail', async () => {
    vi.mocked(completeModel).mockRejectedValue(new Error('network'));
    const result = await generateFollowUpQuestions(input());
    expect(result).toHaveLength(3);
    expect(result[0]).toContain('怎么点拿铁？');
  });
  it('offers English customer replies for mixed-language role-play, including fallback slots', async () => {
    vi.mocked(completeModel).mockResolvedValue({ role: 'assistant', content: '["就这些，可以刷卡吗？", "Could I add a muffin?"]' });
    const request = input();
    request.messages = [
      { role: 'user', content: '我想要一杯冰拿铁，大杯，少冰，谢谢。' },
      { role: 'assistant', content: '(继续扮演咖啡师)\nBarista: Can I get a name for the order? Anything else, like a pastry?\n你可以继续点第二杯，或者说就这些。' },
    ];
    const result = await generateFollowUpQuestions(request);
    expect(result).toHaveLength(3);
    expect(result.every(text => !/[\u3400-\u9fff]/.test(text))).toBe(true);
    expect(result).toContain('Could I add a muffin?');
    expect(result).toContain("That's all, thank you. Can I pay by card?");
  });
  it('uses English fallback after a provider failure during role-play', async () => {
    vi.mocked(completeModel).mockRejectedValue(new Error('timeout'));
    const request = input();
    request.messages[0]!.content = '我们做一次酒店入住的角色扮演，你是前台。';
    request.messages[1]!.content = 'Receptionist: Do you have a reservation?';
    const result = await generateFollowUpQuestions(request);
    expect(result).toHaveLength(3);
    expect(result.every(text => !/[\u3400-\u9fff]/.test(text))).toBe(true);
  });
  it('allows Chinese explanation questions when the user exits role-play to ask about meaning', async () => {
    vi.mocked(completeModel).mockRejectedValue(new Error('network'));
    const request = input();
    request.question = '请解释这句话是什么意思';
    request.messages[0]!.content = request.question;
    request.messages[1]!.content = 'Barista 的意思是咖啡师。';
    expect((await generateFollowUpQuestions(request))[0]).toContain('讲得更简单');
  });

});
