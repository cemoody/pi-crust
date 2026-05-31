/**
 * Parameterized fake `pi --mode rpc` child for use under pirpc-supervisor.mjs.
 *
 * The existing tests/unit/pirpc-supervisor.test.ts has its own ad-hoc inline
 * fake; this helper extracts it into a single source of truth so faults
 * (crashes, hangs, malformed JSON, session-id flips) become declarative.
 *
 * Each call to makeFakePi() materializes a fake-pi script in a tempdir
 * keyed to the desired fault profile, and returns a path that the
 * supervisor can spawn as if it were the real pi binary.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FakePiOptions {
  /** Session id reported by get_state. Defaults to "fake-pi-session". */
  sessionId?: string;
  /** Path used as the session file. Defaults to <runtime>/<sessionId>.jsonl. */
  sessionFile?: string;
  /** Emit N synthetic events before becoming idle. */
  initialEvents?: number;

  // --- fault injection ---

  /** Exit with code 1 after N stdout lines. */
  crashAfterEvents?: number;
  /** Ignore SIGTERM (forces supervisor's SIGKILL escalation path). */
  hangOnSigterm?: boolean;
  /** Emit a long stderr blob (tests the 16KB cap & exit-event truncation). */
  produceStderrBytes?: number;
  /** Switch sessionId to a new value after N events (exercises identity move). */
  flipSessionIdAfter?: number;
  /** New session id used by flipSessionIdAfter. */
  flippedSessionId?: string;
  /** Emit a line of malformed JSON at startup (exercises parser robustness). */
  emitMalformedJson?: boolean;
}

export interface FakePi {
  /** Path of the fake-pi binary script (pass to spawn() as the command). */
  executable: string;
  /** Tempdir holding the script — caller should rm on cleanup. */
  root: string;
  /** Session id this fake will report. */
  sessionId: string;
  /** Session file path. */
  sessionFile: string;
  cleanup(): Promise<void>;
}

export async function makeFakePi(opts: FakePiOptions = {}): Promise<FakePi> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fake-pi-"));
  const sessionId = opts.sessionId ?? "fake-pi-session";
  const sessionFile = opts.sessionFile ?? path.join(root, `${sessionId}.jsonl`);
  await fs.writeFile(sessionFile, "");

  // We materialize this as a runnable .mjs script. The pirpc-supervisor
  // spawns `args.command` directly, so we ship a #! line and chmod +x.
  const script = `#!/usr/bin/env node
let sessionId = ${JSON.stringify(sessionId)};
let sessionFile = ${JSON.stringify(sessionFile)};
const initialEvents = ${opts.initialEvents ?? 0};

// Honor the adapter's --session/--session-dir so the reported sessionFile lives
// in the server's real sessionRoot (makes cold-session discovery + reattach
// behave like production). Falls back to the fixed path when not provided.
import fs0 from "node:fs";
import path0 from "node:path";
{
  const argv = process.argv.slice(2);
  let sDir, sFile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session-dir") sDir = argv[i + 1];
    else if (argv[i] === "--session") sFile = argv[i + 1];
  }
  if (sFile) {
    sessionFile = sFile;
    sessionId = path0.basename(sFile).replace(/\\.jsonl$/, "");
  } else if (sDir) {
    sessionFile = path0.join(sDir, sessionId + ".jsonl");
  }
  // Write a real session header line so fastListSessions() can discover this
  // session (id + cwd + timestamp). An empty file is skipped by the scanner
  // (size===0), which would make the session invisible to cold-session
  // discovery after an API restart — exactly the path the scenarios exercise.
  try {
    fs0.mkdirSync(path0.dirname(sessionFile), { recursive: true });
    if (!fs0.existsSync(sessionFile) || fs0.statSync(sessionFile).size === 0) {
      const header = { type: "session", id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() };
      fs0.writeFileSync(sessionFile, JSON.stringify(header) + "\\n");
    }
  } catch {}
}
const crashAfterEvents = ${opts.crashAfterEvents ?? -1};
const hangOnSigterm = ${!!opts.hangOnSigterm};
const stderrBytes = ${opts.produceStderrBytes ?? 0};
const flipAfter = ${opts.flipSessionIdAfter ?? -1};
const flippedSessionId = ${JSON.stringify(opts.flippedSessionId ?? "fake-pi-session-flipped")};
const emitMalformed = ${!!opts.emitMalformedJson};

let emitted = 0;
function send(o) {
  process.stdout.write(JSON.stringify(o) + "\\n");
  emitted += 1;
  if (crashAfterEvents >= 0 && emitted >= crashAfterEvents) process.exit(1);
  if (flipAfter >= 0 && emitted >= flipAfter && sessionId !== flippedSessionId) {
    sessionId = flippedSessionId;
  }
}
function state() {
  return { sessionId, sessionFile, isStreaming: false, isCompacting: false, messageCount: 0, model: { provider: "fake", id: "model" } };
}

if (stderrBytes > 0) process.stderr.write("X".repeat(stderrBytes) + "\\n");
if (emitMalformed) process.stdout.write("not json\\n");

for (let i = 0; i < initialEvents; i++) send({ type: "event", n: i });

process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  while (true) {
    const i = buf.indexOf("\\n");
    if (i === -1) return;
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (!msg || typeof msg.type !== "string") continue;
    // Respond to every RPC command the adapter issues so request() promises
    // always resolve (an unanswered command would hang the adapter forever).
    if (msg.type === "get_state") {
      send({ type: "response", id: msg.id, command: "get_state", success: true, data: state() });
    } else if (msg.type === "get_session_stats") {
      send({ type: "response", id: msg.id, command: "get_session_stats", success: true, data: { tokens: { total: 0 } } });
    } else if (msg.type === "get_messages") {
      send({ type: "response", id: msg.id, command: "get_messages", success: true, data: { messages: [] } });
    } else {
      // Generic ack for everything else (prompt, abort, compact, rename, ...).
      send({ type: "response", id: msg.id, command: msg.type, success: true });
    }
  }
});

if (hangOnSigterm) {
  process.on("SIGTERM", () => { /* ignore — supervisor must escalate */ });
} else {
  process.on("SIGTERM", () => process.exit(0));
}
process.on("SIGINT", () => process.exit(0));
// Keep stdin open so node doesn't exit when no data is arriving. The
// supervisor relies on the child being long-lived; without this the
// child exits as soon as the initial 'get_state' write completes and
// the supervisor's child.stdin.write() racing against the closed pipe
// emits an unhandled EPIPE 'error' that crashes the supervisor.
process.stdin.resume();
`;
  const executable = path.join(root, "fake-pi.mjs");
  await fs.writeFile(executable, script);
  await fs.chmod(executable, 0o755);
  return {
    executable, root, sessionId, sessionFile,
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); },
  };
}
