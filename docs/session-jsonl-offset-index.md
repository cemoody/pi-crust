# Durable session JSONL offset index

`GET /api/sessions/:id/messages?limit=N` keeps JSONL as the source of truth while
storing a rebuildable sidecar beside each transcript:

```text
.<session>.jsonl.pi-crust-message-offsets.v1.json
```

The sidecar contains only complete JSONL record byte offsets/lengths, timestamps
for the `before` cursor, and a source fingerprint. It deliberately does **not**
contain message bodies. A warm tail request seeks and parses only indexed message
records until the existing `toSessionMessages` fan-out yields the requested page.

## Safety / invalidation

* **Append:** source size grows and the prior head/end anchors still hash-match.
  Only the suffix after the last complete indexed newline is scanned and appended
  to the index.
* **Replacement, truncation, or stale index:** inode/device changes, shrinking
  size, or an anchor mismatch causes a full rebuild from JSONL.
* **Corruption:** malformed JSON, wrong version, invalid/overlapping/out-of-range
  record offsets, or impossible fingerprint fields are ignored and rebuilt.
* **Concurrent write/race:** rebuild and read paths verify a stable stat before
  accepting results; a changed source returns `undefined`, preserving the
  established backwards tail scanner and adapter fallback.
* **Permission/I/O failure:** sidecar persistence is best effort. The request can
  still use the in-memory index, old scanner, or adapter exactly as before.

## Measured isolated benchmark

`tests/unit/session-jsonl-offset-index.test.ts` uses no server or adapter. It
places 32 × 256 KiB giant non-message JSONL records after 96 messages, builds the
sidecar once, then compares a warm two-message page with the old 64 KiB backwards
scan using source-I/O instrumentation.

| path | source bytes read | JSON records parsed |
| --- | ---: | ---: |
| warm offset index | 216 B | 2 |
| legacy tail scan | 8,400,683 B | 129 |

That is ~38,892× less source I/O and ~64.5× fewer JSON parses in a deterministic
case designed to expose the giant-record tail-scan penalty.
