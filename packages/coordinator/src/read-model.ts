import type { BoardColumn, DomainEvent, TranscriptEntry } from "@arke/contracts";

/**
 * The normalized read model the board reads from (PRD §8.5, FR-9; SPEC-003).
 *
 * It folds the stream of domain events into current delivery state. The board column
 * for each card is *computed* from spec status, session status and PR/CI signals —
 * never hand-maintained. Transcript events (`message.part` / `message.updated`) fold into
 * per-session transcript state but NEVER move a card between columns (D1, NFR).
 */
export interface CardState {
  id: string;
  specId: string;
  kind: "spec" | "task";
  title: string;
  column: BoardColumn;
  status: string;
  harness?: string;
  model?: string;
  needsHuman: boolean;
  transcript: TranscriptEntry[];
}

/** Upper bound on retained transcript turns per card (most-recent kept). */
const MAX_TRANSCRIPT = 100;

/** Buffer for parts that arrive before their predecessors (out-of-order delivery). */
interface PartBuffer {
  // partIndex → delta, accumulated until flushed into the transcript entry's text
  parts: Map<number, string>;
  nextIndex: number;
}

export class ReadModel {
  private specStatus = new Map<string, string>();
  private cards = new Map<string, CardState>();
  /** sessionId → messageId → ordering buffer for out-of-order parts. */
  private buffers = new Map<string, Map<string, PartBuffer>>();

  apply(event: DomainEvent): void {
    switch (event.type) {
      case "spec.status": {
        this.specStatus.set(event.specId, event.status);
        const card = this.ensureCard(event.specId, event.specId, "spec");
        card.column = this.deriveColumn(card, event.status);
        break;
      }
      case "session.status": {
        const card = this.ensureCard(event.sessionId, event.specId, event.kind);
        card.status = event.status;
        card.model = event.model ?? card.model;
        card.harness = event.harness;
        card.needsHuman = event.status === "waiting";
        card.column = this.deriveColumn(card, this.specStatus.get(event.specId));
        break;
      }
      case "permission.asked": {
        const card = this.cards.get(event.sessionId);
        if (card) {
          card.needsHuman = true;
          card.column = "needs-human";
        }
        break;
      }
      case "permission.replied": {
        const card = this.cards.get(event.sessionId);
        if (card) card.needsHuman = false;
        break;
      }
      case "message.part":
        this.applyPart(event);
        break;
      case "message.updated":
        this.applyMessageUpdated(event);
        break;
      // turn.quiescent is a runtime receipt for consumers; it carries no read-model state
      // change of its own. diff.finalized / todo.updated / projection.write enrich detail
      // views, not the board column here.
      default:
        break;
    }
  }

  snapshot(): CardState[] {
    return [...this.cards.values()];
  }

  // ---- transcript folding (does NOT affect column) ----

  private applyPart(event: Extract<DomainEvent, { type: "message.part" }>): void {
    const card = this.cards.get(event.sessionId);
    if (!card) return; // a part for a session we have no card for is ignored, not buffered
    const entry = this.ensureTranscriptEntry(card, event.messageId, event.role);

    const byMessage = this.bufferFor(event.sessionId);
    let buf = byMessage.get(event.messageId);
    if (!buf) {
      buf = { parts: new Map(), nextIndex: 0 };
      byMessage.set(event.messageId, buf);
    }
    buf.parts.set(event.partIndex, event.delta);

    // Drain contiguous parts from nextIndex onward, so deltas concatenate in index order.
    while (buf.parts.has(buf.nextIndex)) {
      entry.text += buf.parts.get(buf.nextIndex)!;
      buf.parts.delete(buf.nextIndex);
      buf.nextIndex += 1;
    }
    entry.isStreaming = !event.done || buf.parts.size > 0;
  }

  private applyMessageUpdated(event: Extract<DomainEvent, { type: "message.updated" }>): void {
    const card = this.cards.get(event.sessionId);
    if (!card) return;
    const entry = this.ensureTranscriptEntry(card, event.messageId, event.role);
    // The full snapshot is authoritative; replace accumulated text and close the window.
    entry.text = event.text;
    entry.toolCalls = event.toolCalls;
    entry.role = event.role;
    entry.isStreaming = event.isStreaming;
    // Discard any out-of-order parts still buffered for this message.
    this.bufferFor(event.sessionId).delete(event.messageId);
  }

  private ensureTranscriptEntry(
    card: CardState,
    messageId: string,
    role: TranscriptEntry["role"],
  ): TranscriptEntry {
    let entry = card.transcript.find((t) => t.messageId === messageId);
    if (!entry) {
      entry = { messageId, role, text: "", toolCalls: [], isStreaming: true };
      card.transcript.push(entry);
      // Bound transcript growth for long-running sessions (keep the most recent turns).
      if (card.transcript.length > MAX_TRANSCRIPT) card.transcript.shift();
    }
    return entry;
  }

  private bufferFor(sessionId: string): Map<string, PartBuffer> {
    let m = this.buffers.get(sessionId);
    if (!m) {
      m = new Map();
      this.buffers.set(sessionId, m);
    }
    return m;
  }

  private ensureCard(id: string, specId: string, kind: "spec" | "task"): CardState {
    let card = this.cards.get(id);
    if (!card) {
      card = {
        id,
        specId,
        kind,
        title: id,
        column: "authoring",
        status: "idle",
        needsHuman: false,
        transcript: [],
      };
      this.cards.set(id, card);
    }
    return card;
  }

  /** Compute the board column from real signals (FR-9, Figure 4). */
  private deriveColumn(card: CardState, specStatus?: string): BoardColumn {
    if (card.needsHuman) return "needs-human";
    if (card.kind === "task") {
      if (card.status === "done") return "diff";
      return "implementing";
    }
    switch (specStatus) {
      case "draft":
        return "authoring";
      case "in-review":
        return "review";
      case "approved":
        return "approved";
      case "merged":
        return "merged";
      default:
        return "authoring";
    }
  }
}
