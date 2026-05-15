#!/usr/bin/env node
// pirpc-supervisor.mjs
//
// Long-lived wrapper that owns a `pi --mode rpc` child and exposes its JSONL
// protocol over a per-session Unix domain socket. The API server adapter
// spawns one of these per session, detached, with stdio:"ignore". When the
// API server restarts the supervisor (and the pi child) keep running; the
// new API process reconnects to the socket and replays missed events from a
// bounded in-memory ring buffer.
//
// Wire protocol (line-delimited JSON, both directions):
//   C->S first frame: { "t": "hello", "resumeFromSeq": null | -1 | 0 | N }
//     - null/-1: only live events (do not replay ring)
//     - 0: replay full ring then stream live
//     - N: replay ring entries with seq > N, then stream live. If
//          N is older than the ring's lowest seq, prepend a "resync" frame.
//   S->C first frame (ack): { "t": "hello", "sessionId", "sessionFile",
//                              "cwd", "pid", "lastSeq", "ringLowSeq" }
//   S->C resync (optional, before replay): { "t": "resync", "fromSeq", "ringLowSeq", "lastSeq" }
//   S->C: { "t": "event", "seq": N, "data": <original pi rpc frame> }
//   C->S rpc: { "t": "rpc", "data": <original pi rpc request> }
//             (data is forwarded verbatim to pi child stdin)
//   C->S shutdown: { "t": "shutdown" }
//             (supervisor SIGTERMs pi child and exits cleanly)
//
// CLI flags (all required unless noted):
//   --command <path>        pi binary
//   --cwd <path>            cwd for the pi child
//   --args <json-array>     args to pass to pi
//   --runtime-dir <path>    directory for sockets + status files
//   --worker-token <uuid>   transient handshake token (written to <runtime-dir>/workers/<token>.ready
//                           once the supervisor knows the real sessionId)
//   --ring-size <N>         optional, default 1000

import net from "node:net";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const value = argv[i + 1];
      out[key] = value;
      i++;
    }
  }
  return out;
}

function detachFromTty() {
  // Disconnect stdio handles so this process really detaches.
  try { process.stdin.unref?.(); } catch {}
  try { process.stdout.unref?.(); } catch {}
  try { process.stderr.unref?.(); } catch {}
}

async function atomicWriteJson(target, value) {
  const dir = path.dirname(target);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fsp.rename(tmp, target);
}

class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.shift();
  }
  lowSeq() {
    return this.items.length === 0 ? null : this.items[0].seq;
  }
  since(seq) {
    return this.items.filter((it) => it.seq > seq);
  }
  all() {
    return [...this.items];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const required = ["command", "cwd", "args", "runtime-dir", "worker-token"];
  for (const k of required) {
    if (!args[k]) {
      process.stderr.write(`pirpc-supervisor: missing --${k}\n`);
      process.exit(2);
    }
  }

  const piCommand = args["command"];
  const cwd = path.resolve(args["cwd"]);
  const piArgs = JSON.parse(args["args"]);
  const runtimeDir = path.resolve(args["runtime-dir"]);
  const workerToken = args["worker-token"];
  const ringSize = Number(args["ring-size"] ?? 1000);

  const sessionsDir = path.join(runtimeDir, "sessions");
  const workersDir = path.join(runtimeDir, "workers");
  await fsp.mkdir(sessionsDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(workersDir, { recursive: true, mode: 0o700 });

  // Spawn the real pi RPC child. We own its stdio.
  const child = spawn(piCommand, piArgs, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let childStderr = "";
  child.stderr.on("data", (chunk) => { childStderr = (childStderr + chunk).slice(-16_000); });

  const ring = new RingBuffer(ringSize);
  let lastSeq = 0;
  let sessionId = null;
  let sessionFile = null;
  let statusPath = null;
  let socketPath = null;
  let server = null;
  let currentClient = null;

  function broadcast(frame) {
    if (!currentClient || currentClient.destroyed) return;
    try { currentClient.write(JSON.stringify(frame) + "\n"); } catch {}
  }

  function emitEvent(data) {
    lastSeq += 1;
    const entry = { seq: lastSeq, data };
    ring.push(entry);
    broadcast({ t: "event", seq: entry.seq, data });
    void persistStatus();
  }

  async function persistStatus() {
    if (!statusPath || !sessionId) return;
    try {
      await atomicWriteJson(statusPath, {
        pid: process.pid,
        sessionId,
        socketPath,
        sessionFile,
        cwd,
        lastSeq,
      });
    } catch {
      // best-effort
    }
  }

  // Pending bootstrap response from our self-issued get_state. We intercept
  // this single frame so it doesn't leak into the ring before sessionId is
  // known, but everything else (including events emitted prior to the
  // bootstrap response) goes straight into the ring.
  const BOOTSTRAP_ID = "__supervisor_bootstrap_get_state";
  let bootstrapPending = true;

  // Parse pi child stdout line-by-line.
  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    while (true) {
      const i = stdoutBuffer.indexOf("\n");
      if (i === -1) break;
      const line = stdoutBuffer.slice(0, i).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(i + 1);
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); }
      catch { continue; }

      // Intercept the bootstrap response we issued to learn sessionId.
      if (
        bootstrapPending
        && parsed && parsed.type === "response"
        && parsed.id === BOOTSTRAP_ID
        && parsed.success && parsed.data
      ) {
        bootstrapPending = false;
        if (typeof parsed.data.sessionId === "string") sessionId = parsed.data.sessionId;
        if (typeof parsed.data.sessionFile === "string") sessionFile = parsed.data.sessionFile;
        if (sessionId) void bindSocket();
        // Don't add the bootstrap response to the ring; clients didn't ask
        // for it and the bootstrap id is supervisor-private.
        continue;
      }

      // Opportunistically learn sessionId/sessionFile from subsequent client-issued
      // get_state responses, in case bootstrap raced.
      if (parsed && parsed.type === "response" && parsed.command === "get_state" && parsed.success && parsed.data) {
        if (!sessionId && typeof parsed.data.sessionId === "string") sessionId = parsed.data.sessionId;
        if (!sessionFile && typeof parsed.data.sessionFile === "string") sessionFile = parsed.data.sessionFile;
        if (sessionId && !server) void bindSocket();
      }
      emitEvent(parsed);
    }
  });

  // Kick the child immediately so we learn sessionId before any adapter connects.
  try {
    child.stdin.write(JSON.stringify({ id: BOOTSTRAP_ID, type: "get_state" }) + "\n");
  } catch {}

  child.on("exit", (code, signal) => {
    // Mark child gone; surface a synthetic event so adapters can react.
    emitEvent({ type: "supervisor_child_exit", code, signal, stderr: childStderr.slice(-2000) });
    cleanupExit(0);
  });
  child.on("error", (err) => {
    emitEvent({ type: "supervisor_child_error", message: String(err?.message ?? err) });
    cleanupExit(1);
  });

  async function bindSocket() {
    if (server || !sessionId) return;
    socketPath = path.join(sessionsDir, `${sessionId}.sock`);
    statusPath = path.join(sessionsDir, `${sessionId}.json`);
    // Refuse to steal an active socket from another live supervisor for the
    // same session. If the existing supervisor is alive, exit ourselves; the
    // duplicate spawn is benign (the original keeps serving the session).
    try {
      const text = await fsp.readFile(statusPath, "utf8");
      const status = JSON.parse(text);
      if (status && typeof status.pid === "number" && status.pid !== process.pid) {
        let alive = false;
        try { process.kill(status.pid, 0); alive = true; } catch (err) {
          if (err && err.code === "EPERM") alive = true;
        }
        if (alive && typeof status.socketPath === "string") {
          // Redirect the spawning adapter to the existing supervisor by
          // writing our own .ready file that points at the existing socket.
          // Without this, the adapter's waitForReadyFile would time out (or
          // worse, fail with ENOENT) and the openSession call would error.
          const readyPath = path.join(workersDir, `${workerToken}.ready`);
          try {
            await atomicWriteJson(readyPath, {
              sessionId,
              socketPath: status.socketPath,
              statusPath,
              pid: status.pid,
              redirected: true,
            });
          } catch {}
          emitEvent({
            type: "supervisor_duplicate_exit",
            sessionId,
            existingPid: status.pid,
            pid: process.pid,
          });
          // Mark these paths as not-ours so cleanupExit won't unlink them.
          socketPath = null;
          statusPath = null;
          // Terminate our (now-superfluous) pi child before exiting so it
          // doesn't race the existing supervisor's pi over the session file.
          // shutdown() kills the child then calls cleanupExit().
          shutdown();
          return;
        }
      }
    } catch { /* no existing status, or unreadable: proceed */ }
    try { await fsp.unlink(socketPath); } catch {}
    server = net.createServer((socket) => onConnection(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        try { fs.chmodSync(socketPath, 0o600); } catch {}
        resolve();
      });
    });
    await persistStatus();
    // Announce readiness to the spawning adapter via a transient ready file.
    const readyPath = path.join(workersDir, `${workerToken}.ready`);
    try {
      await atomicWriteJson(readyPath, { sessionId, socketPath, statusPath, pid: process.pid });
    } catch {}
  }

  function onConnection(socket) {
    // One client at a time. If another connects, evict the old.
    if (currentClient && !currentClient.destroyed) {
      try { currentClient.end(); } catch {}
    }
    currentClient = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    let handshakeDone = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const i = buffer.indexOf("\n");
        if (i === -1) break;
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (!handshakeDone) {
          handshakeDone = true;
          handleHello(socket, msg);
          continue;
        }
        if (msg && msg.t === "rpc" && msg.data) {
          try { child.stdin.write(JSON.stringify(msg.data) + "\n"); } catch {}
        } else if (msg && msg.t === "shutdown") {
          shutdown();
        }
      }
    });
    socket.on("error", () => {});
    socket.on("end", () => {
      // Client half-closed; mirror it so our end fully closes too.
      try { socket.end(); } catch {}
    });
    socket.on("close", () => {
      if (currentClient === socket) currentClient = null;
    });
  }

  function handleHello(socket, hello) {
    const ack = {
      t: "hello",
      sessionId,
      sessionFile,
      cwd,
      pid: process.pid,
      lastSeq,
      ringLowSeq: ring.lowSeq(),
    };
    try { socket.write(JSON.stringify(ack) + "\n"); } catch { return; }
    const resumeFromSeq = hello && typeof hello.resumeFromSeq === "number" ? hello.resumeFromSeq : null;
    if (resumeFromSeq === null || resumeFromSeq < 0) return; // live only
    if (resumeFromSeq === 0) {
      // replay full ring
      const items = ring.all();
      if (items.length > 0 && resumeFromSeq < items[0].seq - 1) {
        // by definition 0 < low - 1 when ring has any seq > 1
      }
      for (const it of items) {
        try { socket.write(JSON.stringify({ t: "event", seq: it.seq, data: it.data }) + "\n"); } catch {}
      }
      return;
    }
    // resumeFromSeq > 0
    const low = ring.lowSeq();
    if (low !== null && resumeFromSeq < low - 1) {
      try {
        socket.write(JSON.stringify({ t: "resync", fromSeq: resumeFromSeq, ringLowSeq: low, lastSeq }) + "\n");
      } catch {}
    }
    for (const it of ring.since(resumeFromSeq)) {
      try { socket.write(JSON.stringify({ t: "event", seq: it.seq, data: it.data }) + "\n"); } catch {}
    }
  }

  function shutdown() {
    try { child.kill("SIGTERM"); } catch {}
    const killTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1500);
    child.once("exit", () => {
      clearTimeout(killTimer);
      cleanupExit(0);
    });
  }

  let exiting = false;
  function cleanupExit(code) {
    if (exiting) return;
    exiting = true;
    try { if (currentClient && !currentClient.destroyed) currentClient.end(); } catch {}
    try { server?.close(); } catch {}
    // Only remove the shared per-session files if we are still the owner
    // recorded in statusPath. Otherwise another supervisor for this sessionId
    // has taken over and is the rightful owner of those paths.
    let owns = false;
    if (statusPath) {
      try {
        const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
        owns = status && status.pid === process.pid;
      } catch { /* missing or corrupt: treat as not-ours to be safe */ }
    }
    if (owns) {
      try { if (socketPath) fs.unlinkSync(socketPath); } catch {}
      try { if (statusPath) fs.unlinkSync(statusPath); } catch {}
    }
    setTimeout(() => process.exit(code), 50).unref();
  }

  // Don't honor SIGHUP from the dying API process. We want to keep running.
  process.on("SIGHUP", () => {});
  process.on("SIGTERM", () => shutdown());
  process.on("SIGINT", () => shutdown());

  detachFromTty();
}

main().catch((err) => {
  process.stderr.write(`pirpc-supervisor fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
