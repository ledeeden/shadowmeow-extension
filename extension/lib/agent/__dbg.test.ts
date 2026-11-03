import { it } from 'vitest';
import { htmlToMarkdown } from './export-markdown';
it('debug', () => {
  console.log('UL:', JSON.stringify(htmlToMarkdown('<ul><li>one</li><li>two</li></ul>')));
  console.log('OL:', JSON.stringify(htmlToMarkdown('<ol><li>first</li><li>second</li></ol>')));
  console.log('P:', JSON.stringify(htmlToMarkdown('<p>plain <b>bold</b></p>')));
});
