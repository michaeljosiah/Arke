/**
 * A bounded FIFO of outbound coordinator commands queued while the WebSocket is disconnected
 * (SPEC-006). The cockpit enqueues `prompt.send` commands when offline; on reconnect the queue is
 * drained in order. The bound (default 50) prevents unbounded growth — when full, further enqueue
 * attempts are refused (surfaced to the engineer as "queue full") rather than silently dropped.
 */
export class OutboundQueue<T = unknown> {
  private q: T[] = [];

  constructor(private readonly max = 50) {}

  get size(): number {
    return this.q.length;
  }

  get isFull(): boolean {
    return this.q.length >= this.max;
  }

  /** Enqueue a command; returns false (without mutating) when the queue is already full. */
  enqueue(cmd: T): boolean {
    if (this.isFull) return false;
    this.q.push(cmd);
    return true;
  }

  /** Send every queued command in order via `send`, then clear the queue; returns what was drained. */
  drain(send: (cmd: T) => void): T[] {
    const drained = this.q.slice();
    this.q = [];
    for (const cmd of drained) send(cmd);
    return drained;
  }

  /**
   * Remove and return every queued command without sending — the caller drives the sends itself
   * (e.g. sequentially, awaiting each, so FIFO order and stale-session stops are preserved).
   */
  takeAll(): T[] {
    const taken = this.q.slice();
    this.q = [];
    return taken;
  }

  clear(): void {
    this.q = [];
  }
}
