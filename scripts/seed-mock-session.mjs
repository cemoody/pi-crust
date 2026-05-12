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
