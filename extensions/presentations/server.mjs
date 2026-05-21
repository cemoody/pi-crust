import fs from 'node:fs/promises';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

export default function activate(prc) {
  prc.server.api.get('/api/sessions/:sessionId/presentations/:file', async (request) => {
    const { sessionId, file } = request.params;
    if (!isSafeFileSegment(file)) return { status: 400, body: { error: 'invalid presentation filename' } };
    let session;
    try {
      session = await prc.sessions.get?.(registrySessionId(sessionId));
    } catch (error) {
      return { status: 404, body: { error: error instanceof Error ? error.message : 'unknown session' } };
    }
    if (!session || typeof session !== 'object' || typeof session.cwd !== 'string' || !session.cwd) {
      return { status: 500, body: { error: 'session has no cwd' } };
    }

    const presentationsDir = path.resolve(session.cwd, '.pi/presentations', sessionId);
    const filePath = path.resolve(presentationsDir, file);
    if (filePath !== path.join(presentationsDir, file)) return { status: 400, body: { error: 'path escape rejected' } };

    let stat;
    try { stat = await fs.stat(filePath); } catch { return { status: 404, body: { error: 'presentation not found' } }; }
    if (!stat.isFile()) return { status: 404, body: { error: 'not a file' } };
    const body = await fs.readFile(filePath);
    const ext = path.extname(file).toLowerCase();
    return {
      status: 200,
      headers: {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'private, max-age=300',
      },
      body,
    };
  });
}

function registrySessionId(sessionId) {
  const underscoreIdx = sessionId.lastIndexOf('_');
  return underscoreIdx >= 0 ? sessionId.slice(underscoreIdx + 1) : sessionId;
}

function isSafeFileSegment(file) {
  return typeof file === 'string' && file !== '' && file !== '.' && file !== '..' && !file.includes('/') && !file.includes('\\') && !file.includes('\0');
}
