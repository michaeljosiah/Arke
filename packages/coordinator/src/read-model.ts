import type { BoardColumn, DomainEvent } from "@specone/contracts";

/**
 * The normalized read model the board reads from (PRD §8.5, FR-9).
 *
 * It folds the stream of domain events into current delivery state. The board column
 * for each card is *computed* from spec status, session status and PR/CI signals —
 * never hand-maintained. This skeleton tracks the minimum: per-spec status and per-
 * session status, and derives a column from them.
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
}

export class ReadModel {
  private specStatus = new Map<string, string>();
  private cards = new Map<string, CardState>();

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
      // diff.finalized / todo.updated / projection.write enrich detail views; not
      // yet folded into the board column here.
      default:
        break;
    }
  }

  snapshot(): CardState[] {
    return [...this.cards.values()];
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
