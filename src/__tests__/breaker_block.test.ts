import { describe, it, expect } from 'vitest';
import {
  isPriceInBreakerBlock,
  hasConfluence,
} from '../strategy/breaker_block.js';

describe('breaker_block', () => {
  it('correctly checks isPriceInBreakerBlock', () => {
    const block = {
      type: 'BULLISH' as const,
      high: 62000,
      low: 61500,
      timestamp: 1000,
      index: 5,
      mitigated: false,
    };

    expect(isPriceInBreakerBlock(61800, block)).toBe(true);
    expect(isPriceInBreakerBlock(61500, block)).toBe(true);
    expect(isPriceInBreakerBlock(62000, block)).toBe(true);
    expect(isPriceInBreakerBlock(61499, block)).toBe(false);
    expect(isPriceInBreakerBlock(62001, block)).toBe(false);
  });

  it('correctly identifies confluence between FVG and Breaker Block', () => {
    // Case 1: Overlapping intervals [50, 60] and [55, 65]
    expect(hasConfluence(50, 60, 55, 65)).toBe(true);

    // Case 2: One inside another [52, 58] and [50, 60]
    expect(hasConfluence(52, 58, 50, 60)).toBe(true);

    // Case 3: Disjoint intervals [50, 60] and [65, 75]
    expect(hasConfluence(50, 60, 65, 75)).toBe(false);

    // Case 4: Touching boundary [50, 60] and [60, 70]
    expect(hasConfluence(50, 60, 60, 70)).toBe(true);
  });
});
