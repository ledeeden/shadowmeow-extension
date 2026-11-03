/** Onboarding feedback only. Never grades hearing, pronunciation or FSRS. */
export type ErrorSpan = {
  start: number; end: number; // original reference tokens, exclusive end
  kind: 'omission' | 'replacement' | 'extra';
  attribution: 'possible-spelling' | 'unconfirmed';
};
export const sentenceTokens = (text: string): string[] => text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || [];
const EXPANSIONS: Record<string, string[]> = {
  "don't": ['do','not'], "doesn't": ['does','not'], "didn't": ['did','not'],
  "can't": ['can','not'], cannot: ['can','not'], "won't": ['will','not'],
  "isn't": ['is','not'], "aren't": ['are','not'], "wasn't": ['was','not'],
  "haven't": ['have','not'], "hasn't": ['has','not'], "wouldn't": ['would','not'],
  "shouldn't": ['should','not'], "couldn't": ['could','not'],
  "you're": ['you','are'], "we're": ['we','are'], "they're": ['they','are'],
  "i'm": ['i','am'], "it's": ['it','is'], "that's": ['that','is'],
};
function expand(text: string) {
  return sentenceTokens(text).flatMap((word, index) => {
    const normalized = word.toLowerCase().replaceAll('’', "'");
    return (EXPANSIONS[normalized] || [normalized]).map(token => ({ token, index }));
  });
}
function oneEdit(left: string, right: string): boolean {
  if (left.length < 4 || right.length < 4 || Math.abs(left.length-right.length)>1 || left===right) return false;
  let i=0,j=0,edits=0;
  while(i<left.length && j<right.length) {
    if(left[i]===right[j]) {i++;j++;continue;}
    if(++edits>1) return false;
    if(left.length>=right.length)i++;
    if(right.length>=left.length)j++;
  }
  return edits+(left.length-i)+(right.length-j)===1;
}
/** Bounded word-level Levenshtein alignment. An inserted word is anchored to nearby audio. */
export function alignSentence(reference: string, answer: string): ErrorSpan[] {
  if(answer.length>600 || reference.length>600) throw new Error('句子过长，请限制在 600 个字符内。');
  const a=expand(reference), b=expand(answer), tokenCount=sentenceTokens(reference).length;
  if(a.length>100 || b.length>100) throw new Error('句子过长，请分句练习。');
  if(!a.length) return [];
  const d=Array.from({length:a.length+1},()=>Array<number>(b.length+1).fill(0));
  for(let i=0;i<=a.length;i++) d[i]![0]=i;
  for(let j=0;j<=b.length;j++) d[0]![j]=j;
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++)
    d[i]![j]=Math.min(d[i-1]![j]!+1,d[i]![j-1]!+1,d[i-1]![j-1]!+(a[i-1]!.token===b[j-1]!.token?0:1));
  const errors: ErrorSpan[]=[];
  let i=a.length,j=b.length;
  while(i || j) {
    if(i && j && d[i]![j]===d[i-1]![j-1]!+(a[i-1]!.token===b[j-1]!.token?0:1)) {
      if(a[i-1]!.token!==b[j-1]!.token) errors.push({start:a[i-1]!.index,end:a[i-1]!.index+1,kind:'replacement',attribution:oneEdit(a[i-1]!.token,b[j-1]!.token)?'possible-spelling':'unconfirmed'});
      i--;j--;
    } else if(i && d[i]![j]===d[i-1]![j]!+1) {
      errors.push({start:a[i-1]!.index,end:a[i-1]!.index+1,kind:'omission',attribution:'unconfirmed'});i--;
    } else {
      const anchor=i<a.length?a[i]!.index:tokenCount-1;
      errors.push({start:anchor,end:anchor+1,kind:'extra',attribution:'unconfirmed'});j--;
    }
  }
  errors.sort((x,y)=>x.start-y.start);
  const spans: ErrorSpan[]=[];
  for(const error of errors) {
    const previous=spans.at(-1);
    if(previous && error.start<=previous.end) {
      previous.end=Math.max(previous.end,error.end);
      if(previous.kind!==error.kind)previous.kind='replacement';
      if(previous.attribution!==error.attribution)previous.attribution='unconfirmed';
    } else spans.push({...error});
  }
  return spans;
}
