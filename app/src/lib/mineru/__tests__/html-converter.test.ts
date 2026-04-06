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

  it('5. allows <s>strikethrough</s> and escapes list tags', () => {
    expect(sanitizeFormattedText('<s>deleted</s>')).toBe('<s>deleted</s>');
    // List tags are NOT in ALLOWED_TAGS — they get escaped
    expect(sanitizeFormattedText('<ul><li>item</li></ul>')).toContain('&lt;ul&gt;');
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

  it('12s. allows <sup>text</sup> through for superscripts', () => {
    expect(sanitizeFormattedText('x<sup>2</sup> + y<sup>3</sup>')).toBe(
      'x<sup>2</sup> + y<sup>3</sup>'
    );
  });

  it('13s. allows <sub>text</sub> through for subscripts', () => {
    expect(sanitizeFormattedText('H<sub>2</sub>O')).toBe('H<sub>2</sub>O');
  });

  it('14s. allows nested sup/sub with other formatting', () => {
    expect(sanitizeFormattedText('<strong>x<sup>2</sup></strong>')).toBe(
      '<strong>x<sup>2</sup></strong>'
    );
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

  it('20s. strips <script> tags', () => {
    const result = sanitizeTableHtml('<table><tr><td><script>alert("xss")</script>safe</td></tr></table>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('safe');
  });

  it('21s. strips onclick (quoted) from td', () => {
    const result = sanitizeTableHtml('<td onclick="alert(1)">cell</td>');
    expect(result).not.toContain('onclick');
    expect(result).toContain('cell');
  });

  it('22s. strips onclick (unquoted) from td', () => {
    const result = sanitizeTableHtml('<td onclick=alert(1)>cell</td>');
    expect(result).not.toContain('onclick');
    expect(result).toContain('cell');
  });

  it('23s. strips <iframe> but keeps text content', () => {
    const result = sanitizeTableHtml('<table><tr><td><iframe src="evil.com"></iframe>content</td></tr></table>');
    expect(result).not.toContain('<iframe');
    expect(result).not.toContain('</iframe>');
    expect(result).toContain('content');
  });

  it('24s. strips <form> and <input> tags', () => {
    const result = sanitizeTableHtml('<table><tr><td><form><input></form>text</td></tr></table>');
    expect(result).not.toContain('<form');
    expect(result).not.toContain('<input');
    expect(result).toContain('text');
  });

  it('25s. allows safe table HTML through unchanged', () => {
    const input = '<table><tr><td>safe</td></tr></table>';
    const result = sanitizeTableHtml(input);
    expect(result).toBe(input);
  });

  it('26s. keeps <strong> inside <td>', () => {
    const result = sanitizeTableHtml('<td><strong>bold</strong></td>');
    expect(result).toContain('<strong>bold</strong>');
    expect(result).toContain('<td>');
  });

  it('27s. keeps <sup> and <sub> inside <td>', () => {
    const result = sanitizeTableHtml('<td>10<sup>6</sup> cells/mL</td>');
    expect(result).toContain('<sup>6</sup>');
    expect(result).toContain('<td>');
    const result2 = sanitizeTableHtml('<td>H<sub>2</sub>O</td>');
    expect(result2).toContain('<sub>2</sub>');
  });
});

// --- convertList tests ---

describe('convertList', () => {
  it('20. numbered list preserves markers and renders as list-block', () => {
    const result = convertList('1. First item\n2. Second item\n3. Third item');
    expect(result).toContain('list-block');
    expect(result).toContain('1. First item');
    expect(result).toContain('3. Third item');
  });

  it('21. bullet list preserves markers', () => {
    const result = convertList('• Item one\n• Item two');
    expect(result).toContain('list-block');
    expect(result).toContain('• Item one');
    expect(result).toContain('• Item two');
  });

  it('22. nested roman/letter items get indentation', () => {
    const result = convertList('(i) Question one\n(a) Option A\n(b) Option B\n(ii) Question two');
    expect(result).toContain('list-block');
    // Roman numerals at level 1, letters at level 2 — letters should have more margin
    expect(result).toContain('margin-left');
    expect(result).toContain('(i) Question one');
    expect(result).toContain('(a) Option A');
    expect(result).toContain('(ii) Question two');
  });
});

// --- regionToHtml regression tests ---

describe('regionToHtml', () => {
  it('22. text block with no HTML tags renders same as before (wrapped in <p>)', () => {
    const region = makeRegion({ type: 'text', content: 'Hello world' });
    const result = regionToHtml(region, { joinWithPrevious: false, formulaDisplay: 'rendered', tableDisplay: 'rendered', includeFigures: true, figureDisplay: 'image' });
    expect(result).toBe('<p>Hello world</p>');
  });

  it('28s. formula with valid LaTeX renders via KaTeX', () => {
    const region = makeRegion({
      type: 'formula',
      content: 'E equals mc squared',
      latex: 'E = mc^2',
    });
    const result = regionToHtml(region, { joinWithPrevious: false, formulaDisplay: 'rendered', tableDisplay: 'rendered', includeFigures: true, figureDisplay: 'image' });
    expect(result).toContain('math-block');
    // KaTeX output should NOT contain raw LaTeX
    expect(result).not.toContain('E = mc^2');
    // Should not fall back to <code>
    expect(result).not.toContain('<code>');
  });

  it('29s. formula with malformed LaTeX does not crash', () => {
    const region = makeRegion({
      type: 'formula',
      content: 'bad formula',
      latex: '\\frac{',
    });
    // Should not throw
    const result = regionToHtml(region, { joinWithPrevious: false, formulaDisplay: 'rendered', tableDisplay: 'rendered', includeFigures: true, figureDisplay: 'image' });
    expect(result).toContain('math-block');
  });

  it('30s. formula without latex field uses content as KaTeX source', () => {
    const region = makeRegion({
      type: 'formula',
      content: 'x^2 + y^2 = z^2',
    });
    const result = regionToHtml(region, { joinWithPrevious: false, formulaDisplay: 'rendered', tableDisplay: 'rendered', includeFigures: true, figureDisplay: 'image' });
    expect(result).toContain('math-block');
    expect(result).toContain('katex');
  });

  it('23. figure block with base64 image data renders img tag', () => {
    const region = makeRegion({
      type: 'figure',
      content: 'A chart',
      img_data: 'iVBORw0KGgo=',
      img_mime: 'image/png',
    });
    const result = regionToHtml(region, { joinWithPrevious: false, formulaDisplay: 'rendered', tableDisplay: 'rendered', includeFigures: true, figureDisplay: 'image' });
    expect(result).toContain('<img src="data:image/png;base64,iVBORw0KGgo="');
    expect(result).toContain('<figure>');
    expect(result).toContain('<figcaption>');
  });
});
