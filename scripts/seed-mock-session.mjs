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
    { role: 'assistant', content: 'previously stored response', timestamp: 1700000000001 },
  ],
  lastActivity: Date.now(),
}, null, 2) + '\n');
console.log(`seeded ${sessionFile}`);
