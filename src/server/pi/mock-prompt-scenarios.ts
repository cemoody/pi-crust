import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionUiRequest } from "../../shared/protocol.js";
import type { PiEvent, SessionMessage, SessionStatus } from "./types.js";

/** Operations a synthetic prompt scenario needs from its mock session. */
export interface MockPromptScenarioContext {
  readonly id: string;
  readonly cwd: string;
  appendMessage(message: SessionMessage): void;
  emit(event: PiEvent): void;
  persist(): Promise<void>;
  setStatus(status: SessionStatus): void;
  setLastActivity(timestamp: number): void;
}

/**
 * Runs the mock-only prompts used to exercise interactive UI integrations.
 * Returns whether the message was a recognized scenario directive.
 */
export async function runMockPromptScenario(
  message: string,
  context: MockPromptScenarioContext,
): Promise<boolean> {
  const burst = /^@@burst\s+(\d+)\s+(\d+)\s*$/.exec(message.trim());
  if (burst) {
    await runBurst(Number(burst[1]), Number(burst[2]), context);
    return true;
  }
  if (message.trim() === "@@artifact") {
    await runArtifact(context);
    return true;
  }
  if (message.trim() === "@@extension-ui") {
    await runExtensionUiDemo(message, context);
    return true;
  }
  if (message.trim() === "@@login") {
    await runLoginHandoff(message, context);
    return true;
  }
  return false;
}

async function runLoginHandoff(message: string, context: MockPromptScenarioContext): Promise<void> {
  context.setStatus("running");
  context.emit({ type: "agent_start" });
  const timestamp = Date.now();
  const userMessage: SessionMessage = { role: "user", content: message, timestamp };
  context.appendMessage(userMessage);
  context.emit({ type: "message", message: userMessage });
  await delay(40);

  const assistantMessage: SessionMessage = {
    role: "assistant",
    content:
      "I need to access your private GitHub repos, but you're not signed in. " +
      "I've opened the GitHub login page in the live browser below — please " +
      "enter your username and password, then I'll continue.",
    timestamp: timestamp + 1,
  };
  context.appendMessage(assistantMessage);
  context.emit({ type: "message", message: assistantMessage });
  await delay(40);

  const groupId = crypto.randomBytes(8).toString("hex");
  const artifactMessage = {
    role: "custom" as const,
    content: "browser_request_login: Sign in to GitHub to continue",
    timestamp: Date.now(),
    customType: "artifact",
    details: {
      version: 1,
      artifactGroupId: groupId,
      caption: "🔐 Sign in to GitHub — the agent is waiting for you to log in",
      artifacts: [
        { mime: "text/html", html: browserLoginViewerHtml(process.env.PI_CRUST_BROWSER_WS ?? "ws://127.0.0.1:4000"), height: 520 },
        { mime: "text/plain", text: "Live GitHub login — sign in to continue" },
      ],
    },
  };
  context.appendMessage(artifactMessage as unknown as SessionMessage);
  await context.persist();
  context.emit({ type: "message_start", message: artifactMessage } as unknown as PiEvent);
  await delay(30);
  context.emit({ type: "message_end", message: artifactMessage } as unknown as PiEvent);
  context.setStatus("idle");
  context.setLastActivity(Date.now());
  context.emit({ type: "agent_end", messages: [] });
}

function browserLoginViewerHtml(wsUrl: string): string {
  return [
    "<!doctype html><meta charset=utf8>",
    "<style>html,body{margin:0;height:100%;background:#15151a;font:12px system-ui;color:#ddd}",
    ".bar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid #333}",
    ".dot{width:8px;height:8px;border-radius:50%;background:#3c6;display:inline-block}",
    "#u{opacity:.75;font-family:ui-monospace,monospace}",
    ".wrap{display:flex;align-items:center;justify-content:center;padding:6px}",
    "canvas{max-width:100%;max-height:460px;background:#fff;cursor:crosshair;box-shadow:0 0 0 1px #333}</style>",
    "<div class=bar><span class=dot></span><b>🌐 Browser</b><span id=u>connecting…</span></div>",
    "<div class=wrap><canvas id=c width=1280 height=800 tabindex=0></canvas></div>",
    "<script>",
    "var c=document.getElementById('c'),x=c.getContext('2d'),u=document.getElementById('u'),w=1280,h=800;",
    "var ws=new WebSocket('" + wsUrl + "');",
    "ws.onopen=function(){u.textContent='live';};",
    "ws.onmessage=function(e){var m=JSON.parse(e.data);",
    " if(m.type==='frame'){var i=new Image();i.onload=function(){if(c.width!==m.w){c.width=m.w;c.height=m.h;}w=m.w;h=m.h;x.drawImage(i,0,0,m.w,m.h);};i.src='data:image/jpeg;base64,'+m.data;}",
    " else if(m.type==='meta'&&m.url){u.textContent=m.url;}};",
    "function pt(ev){var r=c.getBoundingClientRect();return{x:Math.round((ev.clientX-r.left)*(w/r.width)),y:Math.round((ev.clientY-r.top)*(h/r.height))};}",
    "function snd(o){if(ws.readyState===1)ws.send(JSON.stringify(o));}",
    "c.addEventListener('mousedown',function(e){var p=pt(e);snd({kind:'mouse',type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});c.focus();});",
    "c.addEventListener('mouseup',function(e){var p=pt(e);snd({kind:'mouse',type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1});});",
    "c.addEventListener('keydown',function(e){snd({kind:'key',type:'keyDown',key:e.key,code:e.code,text:e.key.length===1?e.key:undefined});e.preventDefault();});",
    "<\/script>",
  ].join("\n");
}

async function runExtensionUiDemo(message: string, context: MockPromptScenarioContext): Promise<void> {
  context.setStatus("running");
  context.emit({ type: "agent_start" });
  const timestamp = Date.now();
  const userMessage: SessionMessage = { role: "user", content: message, timestamp };
  context.appendMessage(userMessage);
  context.emit({ type: "message", message: userMessage });
  await delay(30);

  const extensionUiRequests = [
    { id: "status-loop", method: "setStatus", statusKey: "loop", statusText: "⟳ loop · 1 active" },
    { id: "status-review", method: "setStatus", statusKey: "review", statusText: "review · waiting" },
    { id: "widget-loop", method: "setWidget", widgetKey: "loop", widgetLines: ["⟳ #3 Read /home/coder/PROMPT_roofing_dma_pipeline_orchestrator.md — cron: */5 * * * * · next 4m28s 4/500"] },
    { id: "widget-audit", method: "setWidget", widgetKey: "audit", widgetLines: ["finding JSONs: 4/5", "finding MDs: 4/5", "corrected/artifact files: 22"] },
  ] satisfies ExtensionUiRequest[];
  const assistantMessage: SessionMessage = { role: "assistant", content: "Emitted generic extension UI demo requests.", timestamp: timestamp + 1 };
  context.appendMessage(assistantMessage);
  await context.persist();
  context.setStatus("idle");
  context.setLastActivity(Date.now());
  context.emit({ type: "message", message: assistantMessage });
  context.emit({ type: "agent_end", messages: [userMessage, assistantMessage] });
  for (const delayMs of [50, 250, 750, 1500]) {
    setTimeout(() => {
      for (const request of extensionUiRequests) context.emit({ type: "extension_ui_request", ...request } as PiEvent);
    }, delayMs).unref?.();
  }
}

async function runBurst(intervalMs: number, durationMs: number, context: MockPromptScenarioContext): Promise<void> {
  context.setStatus("running");
  context.setLastActivity(Date.now());
  context.emit({ type: "agent_start" });
  const start = Date.now();
  let ticks = 0;
  while (Date.now() - start < durationMs) {
    await delay(Math.max(1, intervalMs));
    ticks += 1;
    context.setLastActivity(Date.now());
    context.emit({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta", delta: `tick-${ticks}` } } as PiEvent);
  }
  const assistantMessage: SessionMessage = { role: "assistant", content: `burst complete: ${ticks} ticks over ${durationMs}ms`, timestamp: Date.now() };
  context.appendMessage(assistantMessage);
  context.setLastActivity(Date.now());
  await context.persist();
  context.setStatus("idle");
  context.emit({ type: "agent_end", messages: [assistantMessage] });
}

async function runArtifact(context: MockPromptScenarioContext): Promise<void> {
  context.setStatus("running");
  context.setLastActivity(Date.now());
  context.emit({ type: "agent_start" });
  const groupId = crypto.randomBytes(8).toString("hex");
  const fileName = `${groupId}.png`;
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGNkYPj/n4EIwDiqEAAlMQMG0V8XdQAAAABJRU5ErkJggg==";
  const artifactDir = path.join(context.cwd, ".pi", "artifacts", context.id);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(path.join(artifactDir, fileName), Buffer.from(pngBase64, "base64"));
  const timestamp = Date.now();
  const url = `/api/sessions/${encodeURIComponent(context.id)}/artifacts/${fileName}`;
  const artifactMessage = {
    role: "custom" as const, content: "live-artifact.png (live-artifact.png, 0.1 KB)", timestamp, customType: "artifact",
    details: { version: 1, artifactGroupId: groupId, caption: "Live artifact render", artifacts: [{ mime: "image/png", src: { kind: "url", url }, alt: "live artifact demo image" }, { mime: "text/plain", text: "Live artifact render" }] },
  };
  context.appendMessage(artifactMessage as unknown as SessionMessage);
  await context.persist();
  context.emit({ type: "message_start", message: artifactMessage } as unknown as PiEvent);
  await delay(30);
  context.emit({ type: "message_end", message: artifactMessage } as unknown as PiEvent);
  context.setStatus("idle");
  context.setLastActivity(Date.now());
  context.emit({ type: "agent_end", messages: [] });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
