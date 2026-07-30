import { parentPort, workerData } from "node:worker_threads";
import { readSessionMessagesTail, type TranscriptTailOptions } from "./transcript-tail-reader.js";

interface TailWorkerData {
  readonly sessionFile: string;
  readonly options: TranscriptTailOptions;
}

const port = parentPort;
if (!port) throw new Error("Transcript-tail worker requires a parent port");
const data = workerData as TailWorkerData;

// The acknowledgement lets the parent observe that CPU-bound JSON parsing is
// now isolated before it starts. It is also useful in the deterministic
// responsiveness regression test.
port.postMessage({ type: "started" });
void readSessionMessagesTail(data.sessionFile, data.options)
  .then((messages) => port.postMessage({ type: "result", messages }))
  .catch((error: unknown) => port.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) }))
  .finally(() => port.close());
