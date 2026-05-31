/**
 * seed-mock-session — write a deterministic mock session JSON into
 * .tmp/playwright-sessions so Playwright suites have a stable session
 * to attach to. Used by tests/playwright fixtures that need a populated
 * sidebar without bringing up a real pi worker.
 *
 * No-op idempotent: re-running the script overwrites the same file.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.tmp/playwright-sessions');
const cwd = path.resolve(process.env.PI_CRUST_PROJECT_ROOT ?? process.cwd());
const id = 'seeded-session-0001';
const sessionFile = path.join(root, '0000000000000_seeded-session-0001.mock-session.json');
await fs.mkdir(root, { recursive: true });
await fs.writeFile(sessionFile, JSON.stringify({
  id,
  cwd,
  sessionFile,
  sessionName: 'Seeded session',
  messages: [
    { role: 'user', content: 'previously sent hello', timestamp: 1700000000000 },
    {
      role: 'assistant',
      content: '## Plan\n\n- **bold step** with `inline code`\n- another *italic* step\n\n```ts\nconst answer = 42;\n```',
      timestamp: 1700000000001,
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${sessionFile}`);

// Second seeded session: deliberately wide / overflowing content to exercise
// mobile horizontal-scroll behavior in code blocks, inline code, and long URLs.
const longId = 'seeded-session-longcode';
const longSessionFile = path.join(root, '0000000000001_seeded-session-longcode.mock-session.json');
const longLine = "const veryLongVariableName = someFunctionThatReturnsAValue({ alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5, zeta: 6, eta: 7, theta: 8, iota: 9, kappa: 10, lambda: 11, mu: 12, nu: 13, xi: 14, omicron: 15, pi: 16, rho: 17, sigma: 18, tau: 19, upsilon: 20 });";
const longUrl = 'https://example.com/this/is/an/intentionally/very/long/url/that/should/never/fit/on/a/mobile/viewport/without/wrapping/or/scrolling/path/segments/keep/going/and/going/and/going.html?with=lots&of=query&parameters=to&push=it&even=wider';
const longBacktick = '`thisIsAReallyReallyReallyReallyReallyReallyLongIdentifierUsedAsInlineCodeThatShouldOverflowOnMobile`';
const longContent = [
  '## Long output sample',
  '',
  'Here is a code block with a very long line that should NOT cause horizontal page scroll on mobile:',
  '',
  '```ts',
  longLine,
  '',
  'function shortLine() { return 1; }',
  '',
  '// another long comment line: ' + 'x'.repeat(200),
  '```',
  '',
  'And some inline code: ' + longBacktick + ' followed by more prose.',
  '',
  'A very long URL: ' + longUrl,
  '',
  '```bash',
  'curl -X POST https://api.example.com/v1/some/very/long/endpoint/path?query=' + 'a'.repeat(120) + ' -H "Authorization: Bearer ' + 'b'.repeat(80) + '"',
  '```',
].join('\n');
await fs.writeFile(longSessionFile, JSON.stringify({
  id: longId,
  cwd,
  sessionFile: longSessionFile,
  sessionName: 'Long code session',
  messages: [
    { role: 'user', content: 'show me a very long line of code', timestamp: 1700000001000 },
    { role: 'assistant', content: longContent, timestamp: 1700000001001 },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${longSessionFile}`);

// Third seeded session: reproduces a mobile timeline bug where the compact
// tool rows squeeze the right-aligned status/duration into multiple lines.
// This mirrors real agent traces: a short user request, repeated thinking rows,
// and several long tool commands with 2-word durations like "5 sec" / "30 ms".
const toolWrapId = 'seeded-session-toolwrap';
const toolWrapSessionFile = path.join(root, '0000000000002_seeded-session-toolwrap.mock-session.json');
const toolWrapMessages = [
  { role: 'user', content: 'new test in a new git work tree\nCopy', timestamp: 1700000002000 },
];
let toolTimestamp = 1700000003000;
function addThoughtAndTool({ thought, id: toolId, command, durationMs }) {
  toolWrapMessages.push({
    role: 'assistant',
    content: '',
    thinking: thought,
    timestamp: toolTimestamp,
  });
  toolWrapMessages.push({
    role: 'tool',
    content: '',
    timestamp: toolTimestamp + durationMs,
    tool: {
      id: toolId,
      name: 'bash',
      args: { command },
      status: 'success',
      output: '',
      startedAt: toolTimestamp,
      completedAt: toolTimestamp + durationMs,
    },
  });
  toolTimestamp += durationMs + 1000;
}
addThoughtAndTool({
  thought: 'Exploring the repo issue',
  id: 'tool-wrap-1',
  command: 'pwd && ls',
  durationMs: 6000,
});
addThoughtAndTool({
  thought: 'Investigating connection issues',
  id: 'tool-wrap-2',
  command: 'find /home/coder -maxdepth 3 -name package.json -o -name playwright.config.ts',
  durationMs: 5000,
});
addThoughtAndTool({
  thought: 'Exploring git worktrees',
  id: 'tool-wrap-3',
  command: 'cd /home/coder/code/pi-crust && git worktree list --porcelain',
  durationMs: 5000,
});
addThoughtAndTool({
  thought: 'Creating a new worktree',
  id: 'tool-wrap-4',
  command: 'cd /home/coder/code/pi-crust && git worktree add -b test/mobile-tool-wrap-repro ../pi-crust-mobile-tool-wrap-repro main',
  durationMs: 4000,
});
addThoughtAndTool({
  thought: 'Checking current branch and status',
  id: 'tool-wrap-5',
  command: 'cd /home/coder/code/pi-crust-mobile-tool-wrap-repro && git status --short && git branch --show-current',
  durationMs: 30,
});
await fs.writeFile(toolWrapSessionFile, JSON.stringify({
  id: toolWrapId,
  cwd,
  sessionFile: toolWrapSessionFile,
  sessionName: 'Tool wrap repro session',
  messages: toolWrapMessages,
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${toolWrapSessionFile}`);

// Fourth seeded session: presentation artifact preview/present flow.
const presentationId = 'seeded-session-presentation';
const presentationSessionFile = path.join(root, '0000000000003_seeded-session-presentation.mock-session.json');
await fs.writeFile(presentationSessionFile, JSON.stringify({
  id: presentationId,
  cwd,
  sessionFile: presentationSessionFile,
  sessionName: 'Presentation artifact session',
  messages: [
    { role: 'user', content: 'Create an executive slide deck', timestamp: 1700000004000 },
    {
      role: 'custom',
      content: 'Presentation generated by Pi.',
      timestamp: 1700000004001,
      customType: 'artifact',
      details: {
        version: 1,
        artifactGroupId: 'presentation-demo',
        caption: 'Executive Signal Brief',
        artifacts: [{
          mime: 'application/vnd.pi.presentation+json',
          spec: {
            id: 'executive-signal-brief',
            title: 'Executive Signal Brief',
            subtitle: 'Demand, weather, and pricing signals',
            theme: 'light',
            slides: [
              { template: 'title', title: 'Executive Signal Brief', subtitle: 'Demand, weather, and pricing signals' },
              { template: 'title-bullets', title: 'What changed this week', bullets: [
                { text: 'Permit velocity improved', detail: 'Southwest and Southeast branches recovered fastest.' },
                { text: 'Storm exposure shifted east', detail: 'Near-term roofing demand risk is concentrated across coastal metros.' },
                'Pricing pressure remains category-specific',
              ] },
              { template: 'metric', title: 'Commercial impact', stats: [
                { value: '$25B', label: 'addressable branch spend under monitoring' },
                { value: '8%', label: 'weekly signal movement in priority markets' },
              ] },
              { template: 'html', html: '<section style="padding:4vw"><h1>Pre-rendered slide</h1><p>This slide came from a template pack and is read-only in edit mode.</p></section>' },
            ],
          },
        }],
      },
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${presentationSessionFile}`);

// Fifth seeded session: show_presentation tool result with artifact attached.
// Reproduces the bug where /api/sessions/:id/messages used to drop the
// tool result's details.piRemoteControlArtifact, leaving the pi-crust showing
// raw JSON instead of the inline slide preview after a page reload.
const toolPresId = 'seeded-session-tool-presentation';
const toolPresFile = path.join(root, '0000000000004_seeded-session-tool-presentation.mock-session.json');
const toolPresDeck = {
  title: 'Tool-result Signal Brief',
  subtitle: 'Pi tool show_presentation flow',
  theme: 'light',
  slides: [
    { template: 'title', title: 'Tool-result Signal Brief', subtitle: 'Show_presentation persistence' },
    { template: 'title-bullets', title: 'Why this test exists', bullets: [
      'Tool emits details.piRemoteControlArtifact in result',
      'Server propagates it to message.tool.artifact',
      'pi-crust renders the same card after a page reload',
    ] },
  ],
};
await fs.writeFile(toolPresFile, JSON.stringify({
  id: toolPresId,
  cwd,
  sessionFile: toolPresFile,
  sessionName: 'Tool presentation reload',
  messages: [
    { role: 'user', content: 'Make a tool-result deck', timestamp: 1700000005000 },
    {
      role: 'tool',
      content: 'Displayed presentation deck: Tool-result Signal Brief (2 slides).',
      timestamp: 1700000005100,
      tool: {
        id: 'call_tool_pres',
        name: 'show_presentation',
        args: { title: toolPresDeck.title, slides: toolPresDeck.slides },
        status: 'success',
        output: 'Displayed presentation deck: Tool-result Signal Brief (2 slides).',
        startedAt: 1700000005050,
        completedAt: 1700000005100,
        artifact: {
          version: 1,
          kind: 'presentation',
          title: toolPresDeck.title,
          data: toolPresDeck,
        },
      },
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${toolPresFile}`);

// Sixth seeded session: image-bearing deck used by the
// presentation-cdn-shippable e2e suite to validate that the Download HTML
// flow produces a fully self-contained, CDN-uploadable file (zero network
// requests when loaded from file://).
//
// We write two tiny image files into <cwd>/.pi/presentations/<sessionId>/
// so the presentations extension's asset route can serve them, and so the
// e2e harness can read them off disk and inline via the standalone
// compiler.
const imageDeckId = 'seeded-session-image-deck';
const imageDeckFile = path.join(root, '0000000000006_seeded-session-image-deck.mock-session.json');
const imageDeckAssetDir = path.join(cwd, '.pi/presentations', imageDeckId);
await fs.mkdir(imageDeckAssetDir, { recursive: true });

// 1x1 red PNG (smallest meaningful PNG payload).
const redPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Z3l/2EAAAAASUVORK5CYII=';
await fs.writeFile(path.join(imageDeckAssetDir, 'cover.png'), Buffer.from(redPngBase64, 'base64'));

// Minimal valid SVG.
const plotSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" fill="#1f6feb"/>
  <circle cx="16" cy="16" r="8" fill="#ffd166"/>
</svg>
`;
await fs.writeFile(path.join(imageDeckAssetDir, 'plot.svg'), plotSvg, 'utf8');

await fs.writeFile(imageDeckFile, JSON.stringify({
  id: imageDeckId,
  cwd,
  sessionFile: imageDeckFile,
  sessionName: 'Image-deck presentation',
  messages: [
    { role: 'user', content: 'Make an image-bearing deck for the CDN test', timestamp: 1700000006000 },
    {
      role: 'custom',
      content: 'Presentation generated by Pi.',
      timestamp: 1700000006001,
      customType: 'artifact',
      details: {
        version: 1,
        artifactGroupId: 'presentation-image-deck',
        caption: 'Image-Bearing Deck',
        artifacts: [{
          mime: 'application/vnd.pi.presentation+json',
          spec: {
            title: 'Image-Bearing Deck',
            subtitle: 'CDN-shippable single-file test deck',
            theme: 'light',
            logo: { src: 'cover.png', alt: 'Cover logo' },
            slides: [
              { template: 'title', title: 'Image-Bearing Deck', subtitle: 'CDN-shippable single-file test deck', image: { src: 'cover.png', alt: 'Cover image' } },
              { template: 'title-bullets', title: 'Why this deck exists', image: { src: 'plot.svg', alt: 'Diagram' }, bullets: [
                'Cover image inlined as a data URI',
                'Diagram inlined as a data URI',
                'Loads offline from any static CDN',
              ] },
            ],
          },
        }],
      },
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${imageDeckFile}`);

// Regression for the "session goes blank after sidebar flash" bug. The
// underlying class of failure is: somewhere in the message graph an
// assistant or artifact `text` / `content` field is not a string, and
// `<ReactMarkdown>` throws inside React's render — taking the whole
// session pane down with it because nothing on the path is an error
// boundary. Pinned by tests/playwright/markdown-safe.spec.ts.
const blankBugId = 'seeded-session-blank-bug';
const blankBugFile = path.join(root, '0000000000010_seeded-session-blank-bug.mock-session.json');
await fs.writeFile(blankBugFile, JSON.stringify({
  id: blankBugId,
  cwd,
  sessionFile: blankBugFile,
  sessionName: 'Blank-bug repro session',
  messages: [
    { role: 'user', content: 'hello', timestamp: 1700000010000 },
    // An assistant message whose `content` is an object — would feed
    // react-markdown a non-string children prop without the safe-markdown
    // coercion shipped with this fix.
    {
      role: 'assistant',
      content: { type: 'wrong-shape', value: 'this should be a string' },
      timestamp: 1700000010001,
    },
    { role: 'user', content: 'and a follow-up that should still render', timestamp: 1700000010002 },
    { role: 'assistant', content: 'follow-up reply', timestamp: 1700000010003 },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${blankBugFile}`);

// Repro for the "tool calls + thinking render as raw JSON after reload" bug.
//
// Production pirpc sessions persist assistant turns as a structured
// `content` ARRAY of typed blocks (text, thinking, toolCall) — not a flat
// string. The pirpc-pi-adapter normally fans those blocks out into
// separate timeline entries (assistant body, thinking card, tool row +
// matching tool result) via its contentTextAndThinking() helper. The
// /messages API mapping in toDashboardMessages, however, sets
// `text: message.content` verbatim — so a SessionMessage that still has
// an array content payload at that point bypasses the normalization step
// and the pi-crust receives `text: [{type:'text'},{type:'toolCall'},...]`.
//
// Symptoms in the pi-crust: literal `{ "type": "toolCall", "name": "bash",
// ... }` text rendered inside the assistant bubble (because the array is
// stringified by the safe-markdown coercion shipped in PR #110/#111), and
// no tool card at all because the toolCall block was never split out
// into its own `role: "tool"` entry.
//
// We pin the bug here by writing a .mock-session.json whose `messages`
// field carries structured-array content directly. The mock adapter
// faithfully forwards it through getMessages(), toDashboardMessages then
// hands the array to the pi-crust as `text`, and any UI code path that
// expects a string sees the raw blocks.
//
// Pinned by tests/playwright/structured-content-tool-calls.spec.ts.
const structuredId = 'seeded-session-structured-content';
const structuredMockFile = path.join(root, '0000000000011_seeded-session-structured-content.mock-session.json');

const structuredTs0 = 1700000020000;
const structuredTs1 = 1700000020100;
const structuredTs2 = 1700000020200;

await fs.writeFile(structuredMockFile, JSON.stringify({
  id: structuredId,
  cwd,
  sessionFile: structuredMockFile,
  sessionName: 'Structured tool-call session',
  messages: [
    {
      role: 'user',
      // Structured user content: a single text block. Real pirpc/Anthropic
      // sessions store user prompts this way once attachments enter the
      // picture.
      content: [{ type: 'text', text: 'find the slides extension' }],
      timestamp: structuredTs0,
    },
    {
      role: 'assistant',
      // The structured assistant turn that triggers the regression:
      // text + thinking + toolCall blocks side-by-side. The pirpc-pi-
      // adapter would normally split this into (assistant body) +
      // (thinking card) + (tool row), but if anything in the read path
      // skips the contentTextAndThinking() helper the pi-crust sees the raw
      // array.
      content: [
        { type: 'text', text: 'Let me look under `extensions/`.' },
        {
          type: 'thinking',
          thinking: 'Let me locate the slides extension and inspect its layout.',
          thinkingSignature: 'sig-fixture-1',
        },
        {
          type: 'toolCall',
          id: 'toolu_seeded_bash_find_slides',
          name: 'bash',
          arguments: { command: 'find /home/coder -type d -name "*slide*" 2>/dev/null | head -20' },
        },
      ],
      timestamp: structuredTs1,
    },
    {
      role: 'tool',
      content: '/home/coder/code/pi-crust/extensions/slides',
      timestamp: structuredTs1 + 50,
      tool: {
        id: 'toolu_seeded_bash_find_slides',
        name: 'bash',
        args: { command: 'find /home/coder -type d -name "*slide*" 2>/dev/null | head -20' },
        status: 'success',
        output: '/home/coder/code/pi-crust/extensions/slides',
        startedAt: structuredTs1,
        completedAt: structuredTs1 + 50,
      },
    },
    {
      role: 'assistant',
      // Pure-text structured content (no thinking, no toolCall). Even
      // this minimal shape currently breaks the timeline because
      // toDashboardMessages sets text=[{type:'text',text:'...'}] verbatim
      // and the markdown renderer treats it as a JSON blob.
      content: [
        { type: 'text', text: '## Found the extension\n\nIt lives under `extensions/slides`. Here is the **plan**.' },
      ],
      timestamp: structuredTs2,
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${structuredMockFile}`);

// Generic-surface "kitchen-sink" seed. Used by tests/playwright/
// kitchen-sink-rendering.spec.ts and related generic regression specs.
//
// The goal is to pack one mock session with every common shape the
// timeline / artifact renderers know how to render, so that a regression
// in any one shape — falling back to raw JSON, blanking the page, or
// silently dropping a renderer — fails a single CI spec instead of
// requiring per-shape fixtures sprinkled across the repo.
//
// Shapes covered:
//   - Plain user text + plain assistant text (sanity)
//   - Assistant markdown: heading, list, *italic*, **bold**, inline `code`,
//     fenced ```ts code block``` — exercises ReactMarkdown + the
//     coerceMarkdownInput safe path.
//   - A `thinking` block (renders as a thinking tool-card).
//   - A toolCall + matching tool result (renders as tool-card "bash").
//   - A multi-MIME `customType: 'artifact'` row with text/markdown +
//     image/png + text/html representations — exercises
//     pickRenderableRepresentation across the three most common mimes.
//   - A vega-lite artifact attached to a tool result (exercises the
//     Suspense-loaded LazyVegaLiteChart code path).
const kitchenSinkId = 'seeded-session-kitchen-sink';
const kitchenSinkFile = path.join(root, '0000000000020_seeded-session-kitchen-sink.mock-session.json');

// 1x1 transparent PNG.
const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const kitchenTs = 1700000030000;

await fs.writeFile(kitchenSinkFile, JSON.stringify({
  id: kitchenSinkId,
  cwd,
  sessionFile: kitchenSinkFile,
  sessionName: 'Kitchen sink session',
  messages: [
    { role: 'user', content: 'render everything you know how to render', timestamp: kitchenTs },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '## Rendering checklist\n\n- **bold step** with `inline code`\n- another *italic* step\n- [a link](https://example.com)\n\n```ts\nconst answer = 42;\n```' },
        {
          type: 'thinking',
          thinking: 'I should narrate every renderer the pi-crust supports.',
          thinkingSignature: 'sig-kitchen-sink-1',
        },
        {
          type: 'toolCall',
          id: 'toolu_kitchen_bash_echo',
          name: 'bash',
          arguments: { command: 'echo "kitchen sink"' },
        },
      ],
      timestamp: kitchenTs + 1,
    },
    {
      role: 'tool',
      content: 'kitchen sink\n',
      timestamp: kitchenTs + 2,
      tool: {
        id: 'toolu_kitchen_bash_echo',
        name: 'bash',
        args: { command: 'echo "kitchen sink"' },
        status: 'success',
        output: 'kitchen sink\n',
        startedAt: kitchenTs + 1,
        completedAt: kitchenTs + 2,
      },
    },
    // Multi-MIME pi-artifact row: markdown + image + html, in priority
    // order. The pi-crust's pickRenderableRepresentation walks the array and
    // picks the first recognized mime, so the order here matters for
    // assertions in the spec.
    {
      role: 'custom',
      content: 'Kitchen-sink multi-MIME artifact',
      timestamp: kitchenTs + 3,
      customType: 'artifact',
      details: {
        version: 1,
        artifactGroupId: 'kitchen-sink-artifact',
        caption: 'Multi-MIME demo',
        artifacts: [
          { mime: 'text/markdown', text: '### Markdown rep\n\nA **markdown** representation.' },
          { mime: 'image/png', src: { kind: 'url', url: `data:image/png;base64,${tinyPngBase64}` }, alt: 'tiny pixel' },
          { mime: 'text/html', html: '<!doctype html><html><body><p id="kitchen-html">html-rep-ok</p></body></html>', height: 80 },
        ],
      },
    },
    // Vega-lite artifact attached to a tool result. This is the path the
    // pi-artifact / show_artifact(kind=vega-lite) tool uses in prod.
    {
      role: 'tool',
      content: 'Rendered chart',
      timestamp: kitchenTs + 4,
      tool: {
        id: 'toolu_kitchen_vega',
        name: 'show_artifact',
        args: { kind: 'vega-lite' },
        status: 'success',
        output: 'Rendered chart',
        startedAt: kitchenTs + 3,
        completedAt: kitchenTs + 4,
      },
    },
    {
      role: 'custom',
      content: 'Vega-lite chart artifact',
      timestamp: kitchenTs + 5,
      customType: 'artifact',
      details: {
        version: 1,
        artifactGroupId: 'kitchen-sink-vega',
        caption: 'Tiny bar chart',
        artifacts: [
          {
            mime: 'application/vnd.vega-lite.v5+json',
            spec: {
              $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
              data: { values: [
                { category: 'A', value: 4 },
                { category: 'B', value: 6 },
                { category: 'C', value: 10 },
              ] },
              mark: 'bar',
              encoding: {
                x: { field: 'category', type: 'nominal' },
                y: { field: 'value', type: 'quantitative' },
              },
            },
          },
        ],
      },
    },
    // Trailing assistant text — make sure the timeline still flows
    // normal messages after a stack of custom rows.
    {
      role: 'assistant',
      content: 'All shapes emitted. Nothing here should appear as raw JSON.',
      timestamp: kitchenTs + 6,
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${kitchenSinkFile}`);

// Generic-surface "message shape extras" seed. Pins distinct rendering
// for the rarer message shapes the timeline knows about but no existing
// fixture exercises:
//
//   - role:"summary", summaryKind:"compaction"  → "Compaction summary"
//   - role:"summary", summaryKind:"branch"      → "Branch summary"
//   - assistant with errorMessage / stopReason:"error" → error badge +
//     scoped error message rendered in its own <p role="alert">
//
// Used by tests/playwright/message-shapes-extras.spec.ts.
const shapeExtrasId = 'seeded-session-shape-extras';
const shapeExtrasFile = path.join(root, '0000000000021_seeded-session-shape-extras.mock-session.json');
const shapeTs = 1700000040000;
await fs.writeFile(shapeExtrasFile, JSON.stringify({
  id: shapeExtrasId,
  cwd,
  sessionFile: shapeExtrasFile,
  sessionName: 'Message shape extras',
  messages: [
    { role: 'user', content: 'kick off the long-running flow', timestamp: shapeTs },
    {
      role: 'summary',
      summaryKind: 'compaction',
      content: 'Conversation was compacted to save context. Older turns are summarized.',
      timestamp: shapeTs + 1,
    },
    {
      role: 'assistant',
      content: 'After compaction, here is what I remember and what we should do next.',
      timestamp: shapeTs + 2,
    },
    {
      role: 'summary',
      summaryKind: 'branch',
      content: 'Forked from message #1 of the parent session.',
      timestamp: shapeTs + 3,
    },
    {
      role: 'user',
      content: 'try the action that fails',
      timestamp: shapeTs + 4,
    },
    {
      role: 'assistant',
      content: '',
      timestamp: shapeTs + 5,
      stopReason: 'error',
      errorMessage: 'provider returned 500: simulated upstream error',
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${shapeExtrasFile}`);

// Seventh seeded session: a deliberately long transcript used by
// long-session-pagination.spec.ts to exercise the timeline's on-demand
// "load older messages" pagination. 1000 messages (500 user/assistant
// pairs) — well over the 200-message INITIAL_MESSAGES_LIMIT cap — with
// unique FIRST-MESSAGE-MARKER-α / LAST-MESSAGE-MARKER-ω sentinels at the
// extremes so the spec can verify the very first message is reachable
// only after scrolling up enough times to trigger pagination.
const paginationSessionId = 'seeded-session-long-pagination';
const paginationSessionFile = path.join(root, '0000000000007_seeded-session-long-pagination.mock-session.json');
const PAGINATION_TURNS = 500;
const paginationMessages = [];
const paginationBaseTs = 1700000007000;
for (let i = 0; i < PAGINATION_TURNS; i++) {
  const userTag = i === 0 ? 'FIRST-MESSAGE-MARKER-α' : `turn-${i}-user`;
  paginationMessages.push({
    role: 'user',
    content: `${userTag}: user message number ${i}`,
    timestamp: paginationBaseTs + i * 2,
  });
  const assistantTag = i === PAGINATION_TURNS - 1 ? 'LAST-MESSAGE-MARKER-ω' : `turn-${i}-assistant`;
  paginationMessages.push({
    role: 'assistant',
    content: `${assistantTag}: assistant reply number ${i}`,
    timestamp: paginationBaseTs + i * 2 + 1,
  });
}
await fs.writeFile(paginationSessionFile, JSON.stringify({
  id: paginationSessionId,
  cwd,
  sessionFile: paginationSessionFile,
  sessionName: 'Long pagination session',
  messages: paginationMessages,
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${paginationSessionFile}`);

// Eighth seeded session: an artifact-image session used by
// artifact-image-render.spec.ts to verify that the bundled artifacts
// extension can SERVE the artifact bytes for a session that is only listed
// (cold) and not necessarily loaded into the in-memory registry. The
// custom_message carries an image artifact whose URL points at
// /api/sessions/:id/artifacts/:file — the route that previously 500'd with
// "session has no cwd" because the extension host had no sessions API bound.
const artifactSessionId = 'seeded-session-artifact-image';
const artifactSessionFile = path.join(root, '0000000000008_seeded-session-artifact-image.mock-session.json');
const artifactFileName = 'seeded-artifact-image.png';
const artifactUrl = `/api/sessions/${encodeURIComponent(artifactSessionId)}/artifacts/${artifactFileName}`;
// A real 1x1-scaled PNG (solid blue 2x2) so naturalWidth > 0 once served.
const artifactPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNkYPj/n4EIwDiqEAAlMQMG0V8XdQAAAABJRU5ErkJggg==';
const artifactDir = path.join(cwd, '.pi', 'artifacts', artifactSessionId);
await fs.mkdir(artifactDir, { recursive: true });
await fs.writeFile(path.join(artifactDir, artifactFileName), Buffer.from(artifactPngBase64, 'base64'));
await fs.writeFile(artifactSessionFile, JSON.stringify({
  id: artifactSessionId,
  cwd,
  sessionFile: artifactSessionFile,
  sessionName: 'Artifact image session',
  messages: [
    { role: 'user', content: 'Please display the screenshot.', timestamp: 1700000008000 },
    {
      role: 'custom',
      content: 'seeded-artifact-image.png (seeded-artifact-image.png, 0.1 KB)',
      timestamp: 1700000008001,
      customType: 'artifact',
      details: {
        version: 1,
        artifactGroupId: 'seeded-image-demo',
        caption: 'Seeded session artifact image',
        artifacts: [
          { mime: 'image/png', src: { kind: 'url', url: artifactUrl }, alt: 'seeded artifact demo image' },
          { mime: 'text/plain', text: 'Seeded session artifact image' },
        ],
      },
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${artifactSessionFile}`);

// Ninth seeded session: a MULTI-ARTIFACT session used by
// artifact-multi-render.spec.ts. It contains:
//   - two separate image artifact custom_messages (each its own group + file),
//     to prove multiple artifact images all load (not just the first), and
//   - one non-image (application/json) artifact, to prove the artifact
//     renderer handles a non-image representation alongside images without
//     breaking the image loads.
const multiSessionId = 'seeded-session-artifact-multi';
const multiSessionFile = path.join(root, '0000000000009_seeded-session-artifact-multi.mock-session.json');
const multiPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNkYPj/n4EIwDiqEAAlMQMG0V8XdQAAAABJRU5ErkJggg==';
const multiDir = path.join(cwd, '.pi', 'artifacts', multiSessionId);
await fs.mkdir(multiDir, { recursive: true });
const multiFileA = 'multi-a.png';
const multiFileB = 'multi-b.png';
const multiJsonFile = 'multi-data.json';
await fs.writeFile(path.join(multiDir, multiFileA), Buffer.from(multiPngBase64, 'base64'));
await fs.writeFile(path.join(multiDir, multiFileB), Buffer.from(multiPngBase64, 'base64'));
await fs.writeFile(path.join(multiDir, multiJsonFile), JSON.stringify({ ok: true, items: [1, 2, 3] }, null, 2));
const multiUrl = (file) => `/api/sessions/${encodeURIComponent(multiSessionId)}/artifacts/${file}`;
await fs.writeFile(multiSessionFile, JSON.stringify({
  id: multiSessionId,
  cwd,
  sessionFile: multiSessionFile,
  sessionName: 'Artifact multi session',
  messages: [
    { role: 'user', content: 'Show both charts and the data.', timestamp: 1700000009000 },
    {
      role: 'custom',
      content: 'multi-a.png (multi-a.png, 0.1 KB)',
      timestamp: 1700000009001,
      customType: 'artifact',
      details: {
        version: 1,
        artifactGroupId: 'multi-image-a',
        caption: 'Multi artifact image A',
        artifacts: [
          { mime: 'image/png', src: { kind: 'url', url: multiUrl(multiFileA) }, alt: 'multi artifact image A' },
          { mime: 'text/plain', text: 'Multi artifact image A' },
        ],
      },
    },
    {
      role: 'custom',
      content: 'multi-b.png (multi-b.png, 0.1 KB)',
      timestamp: 1700000009002,
      customType: 'artifact',
      details: {
        version: 1,
        artifactGroupId: 'multi-image-b',
        caption: 'Multi artifact image B',
        artifacts: [
          { mime: 'image/png', src: { kind: 'url', url: multiUrl(multiFileB) }, alt: 'multi artifact image B' },
          { mime: 'text/plain', text: 'Multi artifact image B' },
        ],
      },
    },
    {
      role: 'custom',
      content: 'multi-data.json (multi-data.json, 0.1 KB)',
      timestamp: 1700000009003,
      customType: 'artifact',
      details: {
        version: 1,
        artifactGroupId: 'multi-json',
        caption: 'Multi artifact data',
        artifacts: [
          { mime: 'application/json', src: { kind: 'url', url: multiUrl(multiJsonFile) }, alt: 'multi artifact data' },
          { mime: 'text/plain', text: 'Multi artifact data' },
        ],
      },
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${multiSessionFile}`);

// PR Story tool-result session: a show_pr_story tool message whose result
// carries details.piRemoteControlArtifact = { kind: 'pr-story', data }. Used by
// tests/playwright/pr-story-artifact.spec.ts to prove the PR Story card renders
// from the persisted /messages payload alone — i.e. survives a full page reload
// (the history-loader path), mirroring the presentation tool-reload guard. The
// live realtime tool-artifact path is covered by the fast unit reducer test
// tests/unit/pr-story-realtime-render.test.tsx.
const prStoryId = 'seeded-session-pr-story';
const prStoryFile = path.join(root, '0000000000010_seeded-session-pr-story.mock-session.json');
const prStory = {
  schemaVersion: 1,
  id: 'seeded-pr-story',
  title: 'Worker pool review tour',
  pr: {
    owner: 'octo', repo: 'svc', number: 7,
    title: 'Concurrent worker pool for ingestion',
    url: 'https://example.com/octo/svc/pull/7',
    headSha: '0000000000000000000000000000000000000aaa',
  },
  narrative: { strategy: 'entrypoint-first', rationale: 'Walk the dispatch loop before the worker implementation.' },
  chapters: [
    { id: 'ch-dispatch', label: 'Dispatch loop', frameIds: ['frame-import', 'frame-loop'] },
    { id: 'ch-worker', label: 'Worker', frameIds: ['frame-worker'] },
  ],
  frames: [
    {
      id: 'frame-import', chapterId: 'ch-dispatch',
      titleMd: 'The entrypoint imports `WorkerPool`.',
      narrativeMd: 'The dispatch module now depends on an explicit pool abstraction.',
      file: 'src/dispatch.ts', hunkHeader: '@@ +1,4 @@', postLineRange: [1, 2], additions: 1, deletions: 0,
      rows: [
        { kind: 'hunk', text: '@@ +1,4 @@' },
        { kind: 'add', lnOld: null, lnNew: 1, lineId: 'src_dispatch.ts:0:1:R:1', tokens: [ { cls: 'tk-kw', text: 'import' }, { cls: null, text: " { WorkerPool } from './pool'" } ] },
        { kind: 'ctx', lnOld: 2, lnNew: 2, tokens: [{ cls: null, text: 'export async function dispatch(items) {' }] },
      ],
      coverage: { changedLineIds: ['src_dispatch.ts:0:1:R:1'], reviewed: true },
    },
    {
      id: 'frame-loop', chapterId: 'ch-dispatch',
      titleMd: 'The inner loop delegates each job.',
      narrativeMd: 'The pool handles backpressure instead of inline bookkeeping.',
      file: 'src/dispatch.ts', hunkHeader: '@@ +13,6 @@', postLineRange: [13, 14], additions: 2, deletions: 1,
      rows: [
        { kind: 'hunk', text: '@@ +13,6 @@' },
        { kind: 'rem', lnOld: 13, lnNew: null, lineId: 'src_dispatch.ts:1:1:L:13', tokens: [{ cls: null, text: '  await Promise.race(inFlight)' }] },
        { kind: 'add', lnOld: null, lnNew: 13, lineId: 'src_dispatch.ts:1:2:R:13', tokens: [ { cls: 'tk-kw', text: 'for await' }, { cls: null, text: ' (const job of items) {' } ] },
        { kind: 'add', lnOld: null, lnNew: 14, lineId: 'src_dispatch.ts:1:3:R:14', tokens: [{ cls: null, text: '  await pool.assign(job)' }] },
      ],
      coverage: { changedLineIds: ['src_dispatch.ts:1:1:L:13', 'src_dispatch.ts:1:2:R:13', 'src_dispatch.ts:1:3:R:14'], reviewed: true },
    },
    {
      id: 'frame-worker', chapterId: 'ch-worker',
      titleMd: 'New `Worker` class wraps one run loop.',
      narrativeMd: 'Each pool slot owns a worker and backpressure emerges from awaited assignment.',
      file: 'src/worker.ts', hunkHeader: '@@ +1,3 @@', postLineRange: [1, 3], additions: 1, deletions: 0, isNewFile: true,
      rows: [
        { kind: 'hunk', text: '@@ +1,3 @@' },
        { kind: 'add', lnOld: null, lnNew: 1, lineId: 'src_worker.ts:2:1:R:1', tokens: [ { cls: 'tk-kw', text: 'export class' }, { cls: 'tk-ty', text: ' Worker' }, { cls: null, text: ' {' } ] },
      ],
      coverage: { changedLineIds: ['src_worker.ts:2:1:R:1'], reviewed: true },
    },
  ],
  coverage: { totalChangedLines: 5, reviewedChangedLines: 5, percent: 100, strict: true },
};
await fs.writeFile(prStoryFile, JSON.stringify({
  id: prStoryId,
  cwd,
  sessionFile: prStoryFile,
  sessionName: 'PR Story tool reload',
  messages: [
    { role: 'user', content: 'Walk me through PR #7', timestamp: 1700000010000 },
    {
      role: 'tool',
      content: 'Displayed PR Story: Worker pool review tour (3 frames).',
      timestamp: 1700000010100,
      tool: {
        id: 'call_show_pr_story',
        name: 'show_pr_story',
        args: { story: { id: prStory.id, title: prStory.title } },
        status: 'success',
        output: 'Displayed PR Story: Worker pool review tour (3 frames).',
        startedAt: 1700000010050,
        completedAt: 1700000010100,
        artifact: { version: 1, kind: 'pr-story', title: prStory.title, storyId: prStory.id, data: prStory },
      },
    },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${prStoryFile}`);
