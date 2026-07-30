import { describe, expect, it } from 'vitest';
import { coercePrStory, validatePrStory } from '../../src/pr-story/pr-story.js';
import { prStoryFixture } from '../fixtures/pr-story-artifact.js';

function invalidStory() {
  return structuredClone({
    ...prStoryFixture,
    chapters: [
      ...prStoryFixture.chapters,
      { ...prStoryFixture.chapters[0], frameIds: ['missing-frame'] },
    ],
    frames: [
      ...prStoryFixture.frames,
      {
        ...prStoryFixture.frames[0],
        chapterId: 'missing-chapter',
        rows: [
          ...prStoryFixture.frames[0].rows,
          { ...prStoryFixture.frames[0].rows[1], lineId: 'src_dispatch.ts:0:1:R:1' },
        ],
        coverage: { changedLineIds: ['missing-line'], reviewed: true },
      },
    ],
    coverage: { totalChangedLines: 1, reviewedChangedLines: 2, percent: 0 },
  });
}

describe('PR Story relationship validation', () => {
  it('accepts a structurally and relationally valid story', () => {
    expect(validatePrStory(prStoryFixture)).toEqual({ ok: true, errors: [] });
    expect(coercePrStory(prStoryFixture)).toMatchObject({ id: prStoryFixture.id, frames: expect.any(Array) });
  });

  it('reports each cross-reference, uniqueness, and coverage invariant violation', () => {
    const result = validatePrStory(invalidStory());

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      'duplicate chapter id: ch-dispatch',
      'duplicate frame id: frame-import',
      'chapter ch-dispatch references missing frame missing-frame',
      'frame frame-import references missing chapter missing-chapter',
      'frame frame-import has duplicate row lineId src_dispatch.ts:0:1:R:1',
      'frame frame-import coverage references missing row lineId missing-line',
      'coverage reviewedChangedLines exceeds totalChangedLines',
      'coverage percent 0 does not match 200',
    ]));
    expect(() => coercePrStory(invalidStory())).toThrow(/Invalid PR Story:.*duplicate chapter id/);
  });
});
