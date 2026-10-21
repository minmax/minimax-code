# @mavis/mcoded

Skeleton of the resident `mcoded` daemon — the Ф4 wave contract (`final-architecture.md`
§Ф4): the shell a thin client talks to over the pi-rpc wire. The product version
plugs the live conversation runtime in; this wave ships a working daemon frame
with an echo stub behind the runtime seam.

## What is here

- **Unix socket lifecycle** (`daemon.ts`). The socket path comes from the
  durable layout — `resolveMcodedSocketPath(root)` → `<root>/mcoded.sock` — and
  is chmod'ed `0600`. When the process is started with a pre-bound listening
  fd (`LISTEN_FDS`, the launchd/systemd socket-activation convention), the fd
  is adopted instead of binding; the socket path then belongs to the supervisor
  and is never unlinked here. A stale socket file left by a crashed process is
  detected (nothing answers on it) and replaced; a socket that still answers
  means a live daemon owns the profile and startup refuses (`daemon-alive`).
- **The wire** (`protocol.ts`, `wire.ts`). JSONL frames with pi-rpc semantics:
  client commands `prompt` / `steer` / `follow_up` / `abort` (request-id via
  the optional `id`, echoed by every response), a `hello` handshake that pins
  the protocol version, `events` to attach to the event stream, and `shutdown`.
  The daemon answers `response` frames, `event` frames stamped with a
  monotonically increasing `cursor`, and `replay_gap` when a requested cursor
  is not retained. The wire runs over any line transport — an in-memory loopback
  pair (`transport.ts`) for tests and embedding, a `net.Socket` adapter
  (`socket-transport.ts`) for the daemon.
- **Replay ring** (`replay-ring.ts`). Bounded window of recent event frames
  at the Ф4 contract budget (2000 frames / 8 MB, oldest-first eviction — the
  shape of the mcode SSE turn stream, with a smaller frame window).
  Reconnects resume by cursor; anything evicted surfaces as an explicit
  `replay_gap`, never a silent skip.
- **Crash-only restart** (`checkpoint.ts`). The one durable sliver of daemon
  state is the event-sequence watermark, written as a small JSON document
  under the durable root (atomic tmp-rename, coalesced so appends never block
  on disk). On start the daemon resumes the sequence after the checkpoint, so
  cursors are skipped after a crash — never reused.
- **Graceful shutdown** (`hub.ts`, `daemon.ts`). Refuse new work, stop the
  event pump, drain in-flight adapter submissions (bounded), flush the final
  checkpoint, `bye` every client, close and unlink the socket. SIGTERM/SIGINT
  trigger it in `mcodedMain`.
- **Runtime seam** (`runtime-adapter.ts`). The daemon only knows
  `RuntimeAdapter` (submit/abort/events/stop). The shipped
  `EchoRuntimeAdapter` emits deterministic placeholder events; the Ф4 runtime
  replaces it via the `adapter` option.

## Usage

```ts
import { McodedDaemon } from '@mavis/mcoded';

const daemon = new McodedDaemon({ root: '/home/me/.mcode-durable' });
await daemon.start();          // listens on <root>/mcoded.sock, mode 0600
// ... clients connect and speak JSONL: {"type":"hello","version":1}
await daemon.shutdown();       // drain → checkpoint → close+unlink
```

Wire session over an in-memory transport (no sockets involved):

```ts
import { McodedHub, InMemoryCheckpointStore, EchoRuntimeAdapter, createInMemoryTransportPair } from '@mavis/mcoded';

const hub = new McodedHub({
  adapter: new EchoRuntimeAdapter(),
  checkpoint: new InMemoryCheckpointStore(),
});
await hub.start();

const [clientSide, serverSide] = createInMemoryTransportPair();
hub.attachTransport(serverSide);
clientSide.write(JSON.stringify({ type: 'hello', version: 1 }));
```

## Not in this wave

The live agent runtime (behind `RuntimeAdapter`), durable event history for
post-restart replay (the ring is in-memory by design here; reconnects across a
restart answer `replay_gap`), the thin client bundle, byte-bounded write
queues with explicit backpressure, and the Windows named-pipe listener.

Socket activation never re-listens an already-listening fd (Node answers a
second `listen({ fd })` with `EEXIST` — older Linux kernels were the outlier
that allowed it, darwin and current ubuntu kernels refuse). Two adoption
shapes, both pinned by tests: when a server of the same process already holds
the fd, the daemon adopts that server as-is and serves through it; a
cross-process supervisor fd is adopted without a re-listen (`EEXIST` reads as
"already listening"). Anything else (EBADF, EINVAL, …) surfaces as a typed
`not-started` refusal.
