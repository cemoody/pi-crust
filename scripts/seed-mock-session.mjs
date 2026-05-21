import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('.tmp/playwright-sessions');
const cwd = path.resolve(process.env.PI_REMOTE_PROJECT_ROOT ?? process.cwd());
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
  command: 'cd /home/coder/code/pi-remote-control && git worktree list --porcelain',
  durationMs: 5000,
});
addThoughtAndTool({
  thought: 'Creating a new worktree',
  id: 'tool-wrap-4',
  command: 'cd /home/coder/code/pi-remote-control && git worktree add -b test/mobile-tool-wrap-repro ../pi-remote-control-mobile-tool-wrap-repro main',
  durationMs: 4000,
});
addThoughtAndTool({
  thought: 'Checking current branch and status',
  id: 'tool-wrap-5',
  command: 'cd /home/coder/code/pi-remote-control-mobile-tool-wrap-repro && git status --short && git branch --show-current',
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
// tool result's details.piRemoteControlArtifact, leaving the WUI showing
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
      'WUI renders the same card after a page reload',
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
