#!/usr/bin/env node
/**
 * audit-ci-test-coverage — fail-fast gate that ensures every test file
 * under tests/ is actually wired into a job in .github/workflows/ci.yml.
 *
 * Why this exists: a new tests/<bucket>/foo.test.ts that nobody added to
 * the workflow is dead code in disguise — it never runs in PR review,
 * never blocks merge, never catches the regression it was written for.
 * This script enumerates the test files, buckets them by directory, and
 * checks ci.yml contains the matching job + invocation. Runs as part of
 * the typecheck-and-unit job (see package.json `audit:ci-tests`).
 *
 * Exit code: 0 = healthy, 1 = at least one test file or workflow snippet
 * is missing.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const testsDir = path.join(root, "tests");
const workflowPath = path.join(root, ".github", "workflows", "ci.yml");

const testFiles = walk(testsDir)
  .map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
  .filter((file) => /\.(?:test|spec)\.tsx?$/.test(file))
  .sort();

const buckets = {
  vitest: [],
  // The scenario tier (tests/scenarios/**) is a separate, heavyweight,
  // out-of-process suite run via `npm run scenarios`. It intentionally
  // contains RED specs for not-yet-built robustness features (TDD for infra),
  // so it is NOT a PR merge gate yet and is deliberately excluded from the
  // default vitest run (see vitest.config.ts exclude). It is tracked as its
  // own bucket so these files are still accounted for (not "unowned"); no
  // ci.yml job is required until the features land and the specs go green.
  scenarios: [],
  playwrightDefault: [],
  playwrightPromo: [],
  playwrightNpx: [],
  playwrightProduction: [],
  playwrightRealtime: [],
};
const unowned = [];

for (const file of testFiles) {
  if (file.startsWith("tests/playwright/")) {
    if (file === "tests/playwright/promo-screenshots.spec.ts") buckets.playwrightPromo.push(file);
    else if (/\.spec\.tsx?$/.test(file)) buckets.playwrightDefault.push(file);
    else unowned.push(`${file} is under tests/playwright but is not a Playwright .spec.ts/.spec.tsx file`);
    continue;
  }

  if (file.startsWith("tests/playwright-realtime/")) {
    if (/\.spec\.tsx?$/.test(file)) buckets.playwrightRealtime.push(file);
    else unowned.push(`${file} is under tests/playwright-realtime but is not a Playwright .spec.ts/.spec.tsx file`);
    continue;
  }

  if (file.startsWith("tests/playwright-npx/")) {
    if (/\.spec\.tsx?$/.test(file)) buckets.playwrightNpx.push(file);
    else unowned.push(`${file} is under tests/playwright-npx but is not a Playwright .spec.ts/.spec.tsx file`);
    continue;
  }

  if (file.startsWith("tests/playwright-production/")) {
    if (/\.spec\.tsx?$/.test(file)) buckets.playwrightProduction.push(file);
    else unowned.push(`${file} is under tests/playwright-production but is not a Playwright .spec.ts/.spec.tsx file`);
    continue;
  }

  if (file.startsWith("tests/scenarios/")) {
    if (/\.test\.tsx?$/.test(file)) buckets.scenarios.push(file);
    else unowned.push(`${file} is under tests/scenarios but is not a .test.ts/.test.tsx file`);
    continue;
  }

  if (/\.test\.tsx?$/.test(file)) buckets.vitest.push(file);
  else unowned.push(`${file} is outside mapped test directories and is not matched by vitest.config.ts`);
}

if (buckets.playwrightPromo.length !== 1) {
  unowned.push("Expected exactly one promo Playwright spec: tests/playwright/promo-screenshots.spec.ts");
}

const workflow = fs.readFileSync(workflowPath, "utf8");
const requiredWorkflowSnippets = [
  ["typecheck + vitest job", "name: typecheck + vitest"],
  ["vitest command", "npm test -- --reporter=default"],
  ["default Playwright job", "name: playwright (default suite)"],
  ["default Playwright command", "npx playwright test --reporter=list"],
  ["promo Playwright job", "name: playwright (promo screenshots)"],
  ["promo Playwright command", "npm run promo"],
  ["npx extension Playwright job", "name: playwright (npx extension suite)"],
  ["npx extension Playwright command", "npx playwright test --config=playwright.npx-extension.config.ts --reporter=list"],
  ["production smoke job", "name: production build smoke"],
  ["production smoke command", "npx playwright test --config=playwright.production.config.ts --reporter=list"],
  ["realtime Playwright job", "name: playwright (realtime leader-election)"],
  ["realtime Playwright command", "npx playwright test --config=playwright.realtime.config.ts --reporter=list"],
];
for (const [label, snippet] of requiredWorkflowSnippets) {
  if (!workflow.includes(snippet)) unowned.push(`ci.yml is missing ${label}: ${snippet}`);
}

if (unowned.length > 0) {
  console.error("CI test coverage audit failed. These tests/configs are not mapped to PR checks:");
  for (const issue of unowned) console.error(`- ${issue}`);
  process.exit(1);
}

console.log("CI test coverage audit passed:");
console.log(`- vitest: ${buckets.vitest.length} test file(s)`);
console.log(`- playwright default: ${buckets.playwrightDefault.length} spec file(s)`);
console.log(`- playwright promo: ${buckets.playwrightPromo.length} spec file(s)`);
console.log(`- playwright npx extension: ${buckets.playwrightNpx.length} spec file(s)`);
console.log(`- playwright production: ${buckets.playwrightProduction.length} spec file(s)`);
console.log(`- playwright realtime: ${buckets.playwrightRealtime.length} spec file(s)`);
console.log(`- scenarios (npm run scenarios, not a PR gate yet): ${buckets.scenarios.length} test file(s)`);
console.log(`- total: ${testFiles.length} test file(s)`);

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    if (entry.isFile()) return [fullPath];
    return [];
  });
}
