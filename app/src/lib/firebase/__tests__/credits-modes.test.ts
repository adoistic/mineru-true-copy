import { describe, it, expect } from 'vitest';
import { calculateCredits } from '../credits';

describe('calculateCredits — dual-mode OCR pricing', () => {
  it('local mode: 0.25 credits per page', () => {
    const credits = calculateCredits('ocr', 10, { processingMode: 'local', tableMode: 'local' });
    expect(credits).toBe(2.5);
  });

  it('cloud mode: 1 credit per page', () => {
    const credits = calculateCredits('ocr', 10, { processingMode: 'cloud' });
    expect(credits).toBe(10);
  });

  it('hybrid mode: local + cloud tables surcharge', () => {
    const credits = calculateCredits('ocr', 10, {
      processingMode: 'local',
      tableMode: 'cloud',
      tablePagesCount: 3,
    });
    // 10 * 0.25 + 3 * 0.5 = 2.5 + 1.5 = 4.0
    expect(credits).toBe(4.0);
  });

  it('tablePagesCount undefined: no surcharge', () => {
    const credits = calculateCredits('ocr', 10, {
      processingMode: 'local',
      tableMode: 'cloud',
    });
    // No tablePagesCount = no surcharge
    expect(credits).toBe(2.5);
  });

  it('tablePagesCount zero: no surcharge', () => {
    const credits = calculateCredits('ocr', 10, {
      processingMode: 'local',
      tableMode: 'cloud',
      tablePagesCount: 0,
    });
    expect(credits).toBe(2.5);
  });

  it('cloud mode ignores table surcharge', () => {
    const credits = calculateCredits('ocr', 10, {
      processingMode: 'cloud',
      tableMode: 'cloud',
      tablePagesCount: 5,
    });
    // Cloud mode: 1/page flat, no table surcharge (tables already included)
    expect(credits).toBe(10);
  });

  it('defaults to local OCR, cloud tables', () => {
    const credits = calculateCredits('ocr', 10);
    // Default: local (0.25/page), cloud tables (but no tablePagesCount = no surcharge)
    expect(credits).toBe(2.5);
  });
});

describe('calculateCredits — other job types unchanged', () => {
  it('heading_correction: 1 credit per page (unaffected by mode)', () => {
    expect(calculateCredits('heading_correction', 10)).toBe(10);
  });

  it('extract: 1 credit flat', () => {
    expect(calculateCredits('extract', 10)).toBe(1);
  });

  it('wizard: 5 credits per session', () => {
    expect(calculateCredits('wizard', 1)).toBe(5);
  });

  it('translate: 2 credits per page per language', () => {
    expect(calculateCredits('translate', 10, { languageCount: 2 })).toBe(40);
  });

  it('translate: defaults to 1 language', () => {
    expect(calculateCredits('translate', 10)).toBe(20);
  });
});
