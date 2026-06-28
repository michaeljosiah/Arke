import type { DomainEvent } from "@arke/contracts";

/**
 * One connected WebSocket client (SPEC-003). Owns its **per-connection** `seq` counter —
 * not a shared field on the coordinator, which would race when two clients receive events
 * concurrently (D5) — and a bounded outbound buffer so a slow client cannot stall the pump:
 * when the buffer is full the oldest events are dropped and the drop is traced (D10).
 *
 * Ordering guarantee: the snapshot is always the first frame a client sees. Events that
 * arrive while the snapshot is being prepared are queued (not flushed) and the snapshot is
 * placed ahead of them, so no event reaches the client before the snapshot.
 */
export interface OutboundSocket {
  readonly OPEN: number;
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
}

export interface ClientConnectionOptions {
  id: string;
  maxQueue?: number; // events buffered before drop-oldest kicks in
  highWaterMark?: number; // socket bufferedAmount (bytes) above which we stop flushing
  onDrop?: (clientId: string, dropped: number) => void;
}

const DEFAULT_MAX_QUEUE = 256;
const DEFAULT_HIGH_WATER_MARK = 1_000_000; // 1 MB

export class ClientConnection {
  readonly id: string;
  private readonly socket: OutboundSocket;
  private readonly maxQueue: number;
  private readonly highWaterMark: number;
  private readonly onDrop?: (clientId: string, dropped: number) => void;

  private seq = 0; // per-connection
  private queue: string[] = [];
  private ready = false; // becomes true once the snapshot has been queued
  private droppedTotal = 0;

  constructor(socket: OutboundSocket, opts: ClientConnectionOptions) {
    this.socket = socket;
    this.id = opts.id;
    this.maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.highWaterMark = opts.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;
    this.onDrop = opts.onDrop;
  }

  /** Per-connection seq value most recently stamped (for tests/inspection). */
  get currentSeq(): number {
    return this.seq;
  }

  get dropped(): number {
    return this.droppedTotal;
  }

  /** Queue an event frame, stamping a per-connection seq; flushes if ready and not slow. */
  pushEvent(event: DomainEvent): void {
    const frame = JSON.stringify({ type: "event", event: { ...event, seq: ++this.seq } });
    this.enqueue(frame);
  }

  /**
   * Send the snapshot as the first frame: queue events keep buffering until now, then the
   * snapshot is placed ahead of them and the connection starts flushing in order.
   */
  sendSnapshot(frame: string): void {
    this.queue.unshift(frame);
    this.ready = true;
    this.flush();
  }

  private enqueue(frame: string): void {
    this.queue.push(frame);
    this.flush();
    if (this.queue.length > this.maxQueue) {
      const drop = this.queue.length - this.maxQueue;
      this.queue.splice(0, drop); // drop oldest
      this.droppedTotal += drop;
      this.onDrop?.(this.id, drop);
    }
  }

  private flush(): void {
    if (!this.ready) return;
    while (
      this.queue.length > 0 &&
      this.socket.readyState === this.socket.OPEN &&
      this.socket.bufferedAmount < this.highWaterMark
    ) {
      this.socket.send(this.queue.shift()!);
    }
  }
}
