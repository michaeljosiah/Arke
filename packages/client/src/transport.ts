/**
 * ArkeTransport — the client's resilient link to the coordinator (SPEC-003).
 *
 * A five-state machine (`connecting → open → reconnecting → closed → disposed`) over the
 * coordinator WebSocket. Outbound requests sent while not `open` are queued and drained in
 * order — at most once — on the next `open`; the drain runs *after* the first inbound frame
 * (the snapshot) so the board re-renders from the snapshot before any steering is replayed
 * (D3). Reconnect uses capped back-off. State is observable for a connection indicator.
 *
 * Framework-agnostic and DOM-free (the socket is injected), so it unit-tests under node.
 */
export type TransportState = "connecting" | "open" | "reconnecting" | "closed" | "disposed";

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ArkeTransportOptions {
  url: string;
  /** Called with each parsed inbound frame (snapshot / event / ack). */
  onMessage: (frame: unknown) => void;
  /** Socket constructor; defaults to the global WebSocket (browser / Node 22+). */
  createSocket?: WebSocketFactory;
  baseDelayMs?: number; // back-off unit; default 500
  maxDelayMs?: number; // back-off cap; default 10_000
}

const defaultFactory: WebSocketFactory = (url) =>
  new (globalThis as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url);

export class ArkeTransport {
  private readonly url: string;
  private readonly onMessage: (frame: unknown) => void;
  private readonly createSocket: WebSocketFactory;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  private socket: WebSocketLike | null = null;
  private _state: TransportState = "connecting";
  private readonly queue: unknown[] = [];
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingFirstFrame = false;
  private readonly listeners = new Set<(s: TransportState, attempts: number) => void>();

  constructor(opts: ArkeTransportOptions) {
    this.url = opts.url;
    this.onMessage = opts.onMessage;
    this.createSocket = opts.createSocket ?? defaultFactory;
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 10_000;
    this.connect();
  }

  get state(): TransportState {
    return this._state;
  }

  /** Consecutive failed (re)connect attempts since the last successful open — 0 while healthy. */
  get attempts(): number {
    return this.attempt;
  }

  subscribe(listener: (s: TransportState, attempts: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send a steering message; queued (in order, at-most-once) while not open. */
  send(msg: unknown): void {
    if (this._state === "disposed") return;
    if (this._state === "open") {
      this.socket?.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  /** Tear down permanently: no further reconnects, queued messages discarded. */
  dispose(): void {
    this.setState("disposed");
    this.clearTimer();
    this.queue.length = 0;
    this.detachAndClose();
  }

  /** Graceful terminal close (no reconnect), distinct from dispose. */
  close(): void {
    this.setState("closed");
    this.clearTimer();
    this.detachAndClose();
  }

  // ---- internals ----

  private connect(): void {
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.awaitingFirstFrame = true;
      this.setState("open");
    };
    socket.onmessage = (ev) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return; // ignore malformed frame
      }
      this.onMessage(frame);
      if (this.awaitingFirstFrame) {
        this.awaitingFirstFrame = false;
        this.drain(); // drain begins only after the first (snapshot) frame is processed
      }
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };
    socket.onclose = () => {
      if (this._state === "disposed" || this._state === "closed") return;
      this.setState("reconnecting");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.clearTimer();
    this.attempt += 1;
    // Re-emit even though the state stays "reconnecting", so a listener can escalate a *sustained*
    // failure (many attempts) to a distinct "coordinator unreachable" surface instead of an endless
    // "connecting…" — the state alone doesn't change between attempts.
    this.emit();
    const delay = Math.min(this.attempt * this.baseDelayMs, this.maxDelayMs);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    if (this.reconnectTimer && typeof this.reconnectTimer === "object" && "unref" in this.reconnectTimer) {
      (this.reconnectTimer as { unref?: () => void }).unref?.();
    }
  }

  private drain(): void {
    if (this._state !== "open" || !this.socket) return;
    while (this.queue.length > 0) {
      this.socket.send(JSON.stringify(this.queue.shift()));
    }
  }

  private setState(s: TransportState): void {
    if (this._state === s) return;
    this._state = s;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l(this._state, this.attempt);
  }

  private clearTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private detachAndClose(): void {
    const s = this.socket;
    this.socket = null;
    if (s) {
      s.onopen = s.onclose = s.onerror = s.onmessage = null;
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
  }
}
