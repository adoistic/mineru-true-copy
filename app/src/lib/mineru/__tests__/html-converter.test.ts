import { describe, it, expect } from 'vitest';
import {
  sanitizeFormattedText,
  sanitizeTableHtml,
  convertList,
  regionToHtml,
} from '../html-converter';
import type { MineruRegion } from '@/types';

function makeRegion(overrides: Partial<MineruRegion> & { content: string; type: MineruRegion['type'] }): MineruRegion {
  return {
    bbox: [0, 0, 100, 20],
    page_number: 1,
    ...overrides,
  };
}

// --- sanitizeFormattedText tests ---

describe('sanitizeFormattedText', () => {
  it('1. allows <strong>text</strong> through', () => {
    expect(sanitizeFormattedText('<strong>text</strong>')).toBe('<strong>text</strong>');
  });

  it('2. allows <em>text</em> through', () => {
    expect(sanitizeFormattedText('<em>text</em>')).toBe('<em>text</em>');
  });

  it('3. allows <u>text</u> through', () => {
    expect(sanitizeFormattedText('<u>text</u>')).toBe('<u>text</u>');
  });

  it('4. allows <b> and <i> as aliases', () => {
    expect(sanitizeFormattedText('<b>bold</b> and <i>italic</i>')).toBe(
      '<b>bold</b> and <i>italic</i>'
    );
  });

  it('5. allows <ul><li>item</li></ul> and <ol><li>item</li></ol>', () => {
    expect(sanitizeFormattedText('<ul><li>item</li></ul>')).toBe('<ul><li>item</li></ul>');
    expect(sanitizeFormattedText('<ol><li>item</li></ol>')).toBe('<ol><li>item</li></ol>');
  });

  it('6. escapes <script>alert("xss")</script>', () => {
    const result = sanitizeFormattedText('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('7. escapes <div>, <span>, <img>, <iframe> tags', () => {
    expect(sanitizeFormattedText('<div>text</div>')).toContain('&lt;div&gt;');
    expect(sanitizeFormattedText('<span>text</span>')).toContain('&lt;span&gt;');
    expect(sanitizeFormattedText('<img src="x">')).toContain('&lt;img');
    expect(sanitizeFormattedText('<iframe src="x"></iframe>')).toContain('&lt;iframe');
  });

  it('8. strips attributes: <strong class="x">text</strong> -> <strong>text</strong>', () => {
    expect(sanitizeFormattedText('<strong class="x">text</strong>')).toBe(
      '<strong>text</strong>'
    );
  });

  it('9. handles nested tags: <strong><em>text</em></strong>', () => {
    expect(sanitizeFormattedText('<strong><em>text</em></strong>')).toBe(
      '<strong><em>text</em></strong>'
    );
  });

  it('10. plain text with no tags passes through unchanged', () => {
    expect(sanitizeFormattedText('Hello world')).toBe('Hello world');
  });

  it('11. text with &, <, > entities (not part of allowed tags) is escaped', () => {
    expect(sanitizeFormattedText('A & B < C > D')).toBe('A &amp; B &lt; C &gt; D');
  });
});

// --- sanitizeTableHtml tests ---

describe('sanitizeTableHtml', () => {
  it('12. allows style="width: 25%" on td', () => {
    const result = sanitizeTableHtml('<td style="width: 25%">cell</td>');
    expect(result).toContain('width: 25%');
  });

  it('13. allows style="background-color: #f0f0f0"', () => {
    const result = sanitizeTableHtml('<td style="background-color: #f0f0f0">cell</td>');
    expect(result).toContain('background-color: #f0f0f0');
  });

  it('14. allows style="border: 1px solid #000"', () => {
    const result = sanitizeTableHtml('<td style="border: 1px solid #000">cell</td>');
    expect(result).toContain('border: 1px solid #000');
  });

  it('15. strips style="font-family: Arial"', () => {
    const result = sanitizeTableHtml('<td style="font-family: Arial">cell</td>');
    expect(result).not.toContain('font-family');
  });

  it('16. strips style="color: red"', () => {
    const result = sanitizeTableHtml('<td style="color: red">cell</td>');
    expect(result).not.toContain('color');
  });

  it('17. strips !important from any property', () => {
    const result = sanitizeTableHtml('<td style="width: 50% !important">cell</td>');
    expect(result).not.toContain('!important');
    expect(result).not.toContain('width');
  });

  it('18. blocks url() in CSS values', () => {
    const result = sanitizeTableHtml(
      '<td style="background: url(http://evil.com/img.png)">cell</td>'
    );
    expect(result).not.toContain('url(');
  });

  it('19. strips class and id attributes', () => {
    const result = sanitizeTableHtml('<td class="highlight" id="cell-1">cell</td>');
    expect(result).not.toContain('class=');
    expect(result).not.toContain('id=');
  });
});

// --- convertList tests ---

describe('convertList', () => {
  it('20. content with <ul><li> tags passes through sanitizer (not double-wrapped)', () => {
    const result = convertList('<ul><li>item one</li><li>item two</li></ul>');
    expect(result).toBe('<ul><li>item one</li><li>item two</li></ul>');
    // Should NOT have nested <ul><ul>
    expect(result).not.toContain('<ul><ul>');
  });

  it('21. plain text list content uses existing parsing logic', () => {
    const result = convertList('• Item one\n• Item two');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>Item one</li>');
    expect(result).toContain('<li>Item two</li>');
  });
});

// --- regionToHtml regression tests ---

describe('regionToHtml', () => {
  it('22. text block with no HTML tags renders same as before (wrapped in <p>)', () => {
    const region = makeRegion({ type: 'text', content: 'Hello world' });
    const result = regionToHtml(region, false);
    expect(result).toBe('<p>Hello world</p>');
  });

  it('23. figure block with base64 image data renders img tag', () => {
    const region = makeRegion({
      type: 'figure',
      content: 'A chart',
      img_data: 'iVBORw0KGgo=',
      img_mime: 'image/png',
    });
    const result = regionToHtml(region, false);
    expect(result).toContain('<img src="data:image/png;base64,iVBORw0KGgo="');
    expect(result).toContain('<figure>');
    expect(result).toContain('<figcaption>');
  });
});
