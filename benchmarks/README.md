# Benchmarks

## `long-session-tail-read.mts`

A deterministic, **fully isolated** reproduction of the long-session JSONL-tail-read problem. It does not call a pi-crust server already running on the machine.

The benchmark creates a temporary session transcript, starts an in-process HTTP API server on an ephemeral `127.0.0.1` port, requests that server only, then closes the server and removes the temporary directory. The fixture has many normal turns plus multi-megabyte persisted artifact JSONL records inside the most recent transcript window. This is important because the normal API response is small after artifact-detail stripping, while the source record still forces the tail reader to cross and parse a giant line.

```bash
cd /home/coder/pi-crust-long-session-repro
npm run bench:long-session
```

### Default workload

| Setting | Default | Meaning |
| --- | ---: | --- |
| `PI_CRUST_BENCH_LIMIT` | 80 | requested recent timeline messages; matches mobile bootstrap |
| `PI_CRUST_BENCH_TURNS` | 140 | three raw JSONL records per turn (user, assistant tool call, tool result) |
| `PI_CRUST_BENCH_GIANT_RECORD_COUNT` | 12 | giant artifact records deliberately positioned in recent history |
| `PI_CRUST_BENCH_GIANT_RECORD_BYTES` | 6 MiB | source size per giant artifact record |
| `PI_CRUST_BENCH_SAMPLES` | 7 | sequential timing samples |
| `PI_CRUST_BENCH_CONCURRENCY` | 6 | concurrent timeline reads used to measure unrelated API latency |

Examples:

```bash
# Fast feedback while iterating on the parser.
PI_CRUST_BENCH_GIANT_RECORD_BYTES=$((1024 * 1024)) npm run bench:long-session

# Turn the benchmark into a local pass/fail guard after agreeing on a budget.
PI_CRUST_BENCH_MAX_P50_MS=250 npm run bench:long-session
```

The output includes single-read latency, the latency of concurrent timeline reads, and `/api/health` latency both at rest and during those reads. The health delta is a simple signal of Node event-loop interference.
