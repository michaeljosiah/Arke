import type { DomainEvent } from "@arke/contracts";

/**
 * Drains a (reconnecting, never-ending) `streamEvents` iterable in the background, buffering
 * everything so tests can assert on events by predicate without racing `.next()`.
 */
export class EventCollector {
  readonly events: DomainEvent[] = [];
  private readonly waiters: Array<() => boolean> = [];
  private readonly done: Promise<void>;

  constructor(iterable: AsyncIterable<DomainEvent>) {
    this.done = this.run(iterable);
  }

  private async run(iterable: AsyncIterable<DomainEvent>): Promise<void> {
    try {
      for await (const e of iterable) {
        this.events.push(e);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i]!()) this.waiters.splice(i, 1);
        }
      }
    } catch {
      /* aborted */
    }
  }

  /** Resolve with the first buffered event matching `pred`, or reject after `timeoutMs`. */
  waitFor(pred: (e: DomainEvent) => boolean, timeoutMs = 3000): Promise<DomainEvent> {
    const existing = this.events.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise<DomainEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for event")), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.waiters.push(() => {
        const found = this.events.find(pred);
        if (found) {
          clearTimeout(timer);
          resolve(found);
          return true;
        }
        return false;
      });
    });
  }

  async settle(): Promise<void> {
    await this.done;
  }
}
