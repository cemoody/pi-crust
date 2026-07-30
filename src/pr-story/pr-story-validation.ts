import type { PrStory } from './pr-story.js';

/**
 * Checks relationships that cannot be expressed by the structural Zod schema:
 * unique identifiers, cross-frame references, and aggregate coverage totals.
 */
export function validatePrStoryRelationships(story: PrStory): string[] {
  const errors: string[] = [];
  const frameIds = collectUniqueIds(story.frames, 'frame', errors);
  const chapterIds = collectUniqueIds(story.chapters, 'chapter', errors);

  for (const chapter of story.chapters) {
    for (const frameId of chapter.frameIds) {
      if (!frameIds.has(frameId)) errors.push(`chapter ${chapter.id} references missing frame ${frameId}`);
    }
  }

  for (const frame of story.frames) {
    validateFrameRelationships(frame, chapterIds, errors);
  }

  validateCoverageSummary(story, errors);
  return errors;
}

function collectUniqueIds(
  items: readonly { readonly id: string }[],
  itemName: string,
  errors: string[],
): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) errors.push(`duplicate ${itemName} id: ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function validateFrameRelationships(
  frame: PrStory['frames'][number],
  chapterIds: ReadonlySet<string>,
  errors: string[],
): void {
  if (frame.chapterId && !chapterIds.has(frame.chapterId)) errors.push(`frame ${frame.id} references missing chapter ${frame.chapterId}`);

  const rowIds = collectRowIds(frame, errors);
  for (const id of frame.coverage?.changedLineIds ?? []) {
    if (!rowIds.has(id)) errors.push(`frame ${frame.id} coverage references missing row lineId ${id}`);
  }
}

function collectRowIds(frame: PrStory['frames'][number], errors: string[]): Set<string> {
  const rowIds = new Set<string>();
  for (const row of frame.rows) {
    if (row.kind !== 'hunk' && row.lineId) {
      if (rowIds.has(row.lineId)) errors.push(`frame ${frame.id} has duplicate row lineId ${row.lineId}`);
      rowIds.add(row.lineId);
    }
  }
  return rowIds;
}

function validateCoverageSummary(story: PrStory, errors: string[]): void {
  const coverage = story.coverage;
  if (!coverage) return;

  if (coverage.reviewedChangedLines > coverage.totalChangedLines) {
    errors.push('coverage reviewedChangedLines exceeds totalChangedLines');
  }

  const expectedPercent = coverage.totalChangedLines === 0
    ? 100
    : Math.round((coverage.reviewedChangedLines / coverage.totalChangedLines) * 10000) / 100;
  if (Math.abs(expectedPercent - coverage.percent) > 0.01) {
    errors.push(`coverage percent ${coverage.percent} does not match ${expectedPercent}`);
  }
}
