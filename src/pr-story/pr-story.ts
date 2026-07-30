import { z } from 'zod';
import { validatePrStoryRelationships } from './pr-story-validation.js';

export const PR_STORY_MIME = 'application/vnd.pi.pr-story+json';
export const PR_STORY_ARTIFACT_KIND = 'pr-story';

export const TokenClassSchema = z.enum(['tk-kw', 'tk-fn', 'tk-str', 'tk-num', 'tk-com', 'tk-ty']);
export type TokenClass = z.infer<typeof TokenClassSchema>;

export const DiffRowSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hunk'), text: z.string() }),
  z.object({
    kind: z.enum(['ctx', 'add', 'rem']),
    lnOld: z.number().int().nullable(),
    lnNew: z.number().int().nullable(),
    tokens: z.array(z.object({ cls: TokenClassSchema.nullable(), text: z.string() })),
    lineId: z.string().optional(),
  }),
]);
export type DiffRow = z.infer<typeof DiffRowSchema>;

export const PrStoryPrSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
  author: z.string().optional(),
  branch: z.string().optional(),
  baseBranch: z.string().optional(),
  headSha: z.string().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  filesChanged: z.number().int().nonnegative().optional(),
});
export type PrStoryPr = z.infer<typeof PrStoryPrSchema>;

export const PrStoryChapterSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  titleMd: z.string().optional(),
  bodyMd: z.string().optional(),
  frameIds: z.array(z.string().min(1)),
});
export type PrStoryChapter = z.infer<typeof PrStoryChapterSchema>;

export const CoverageSummarySchema = z.object({
  totalChangedLines: z.number().int().nonnegative(),
  reviewedChangedLines: z.number().int().nonnegative(),
  percent: z.number().min(0).max(100),
  strict: z.boolean().optional(),
});
export type CoverageSummary = z.infer<typeof CoverageSummarySchema>;

export const PrStoryFrameSchema = z.object({
  id: z.string().min(1),
  chapterId: z.string().min(1).optional(),
  titleMd: z.string().optional(),
  narrativeMd: z.string().optional(),
  transitionMd: z.string().optional(),
  file: z.string().min(1),
  hunkHeader: z.string().optional(),
  postLineRange: z.tuple([z.number().int(), z.number().int()]).optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  isNewFile: z.boolean().optional(),
  rows: z.array(DiffRowSchema),
  coverage: z.object({
    changedLineIds: z.array(z.string()),
    reviewed: z.boolean(),
  }).optional(),
});
export type PrStoryFrame = z.infer<typeof PrStoryFrameSchema>;

export const PrStorySchemaBase = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  theme: z.string().optional(),
  pr: PrStoryPrSchema,
  narrative: z.object({
    strategy: z.string().min(1),
    rationale: z.string().optional(),
    estimatedMinutes: z.number().int().positive().optional(),
    heroTitleMd: z.string().optional(),
    heroSubtitleMd: z.string().optional(),
  }),
  chapters: z.array(PrStoryChapterSchema),
  frames: z.array(PrStoryFrameSchema).min(1),
  coverage: CoverageSummarySchema.optional(),
});
export type PrStory = z.infer<typeof PrStorySchemaBase>;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validatePrStory(input: unknown): ValidationResult {
  const parsed = PrStorySchemaBase.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'story'}: ${issue.message}`) };
  }
  const errors = validatePrStoryRelationships(parsed.data);
  return { ok: errors.length === 0, errors };
}

export function coercePrStory(input: unknown): PrStory {
  const validation = validatePrStory(input);
  if (!validation.ok) throw new Error(`Invalid PR Story: ${validation.errors.join('; ')}`);
  return PrStorySchemaBase.parse(input);
}
