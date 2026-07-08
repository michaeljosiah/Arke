import type { BoardColumn, DomainEvent, RepoIdentityView, RepoStatusView, TranscriptEntry } from "@arke/contracts";

/**
 * The normalized read model the board reads from (PRD §8.5, FR-9; SPEC-003, SPEC-023).
 *
 * It folds the stream of domain events into current delivery state. A specification is exactly
 * ONE card, keyed on `spec_id`; its harness sessions (the authoring session and any delivery/task
 * sessions) fold into the card's `sessions[]` list rather than each becoming a card of their own
 * (SPEC-023, superseding SPEC-010's `sessionId` card key). The card's column is a *computed*
 * aggregate of the specification's frontmatter status and its folded sessions' states — never
 * hand-maintained. Transcript events fold into per-session transcript state and NEVER move a card.
 */

/** A harness session folded onto its specification's card. Session detail (SPEC-011) reads these. */
export interface SessionRef {
  sessionId: string;
  kind: "spec" | "task";
  status: string;
  model?: string;
  harness?: string;
  needsHuman: boolean;
  transcript: TranscriptEntry[];
  diff?: { added: number; removed: number; files: number };
}

export interface CardState {
  /** The specification id — the card identity (never a sessionId). */
  id: string;
  specId: string;
  title: string;
  column: BoardColumn;
  /** The specification's governed frontmatter status. */
  status: string;
  /** Representative harness/model for the card face (from the most recently active session). */
  harness?: string;
  model?: string;
  /** Aggregate: true iff any folded session has an open human gate. */
  needsHuman: boolean;
  /** The folded harness sessions for this specification. */
  sessions: SessionRef[];
}

/** Upper bound on retained transcript turns per session (most-recent kept). */
const MAX_TRANSCRIPT = 100;

/** Buffer for parts that arrive before their predecessors (out-of-order delivery). */
interface PartBuffer {
  parts: Map<number, string>;
  nextIndex: number;
}

/** Delivery-session statuses that mean the run failed and needs a human (SPEC-023). */
const FAILED_STATUSES = new Set(["interrupted", "error"]);

export class ReadModel {
  private specStatus = new Map<string, string>();
  /** specId → the one card per specification. */
  private cards = new Map<string, CardState>();
  /** sessionId → the specId whose card it folds into (so per-session events find their card). */
  private sessionSpec = new Map<string, string>();
  /** sessionId → messageId → ordering buffer for out-of-order parts. */
  private buffers = new Map<string, Map<string, PartBuffer>>();
  /** sessionId → open human-gate ids (permissionIds + elicitation questionIds). `needsHuman` is sticky
   *  while any gate is open, so an unrelated session.status/todo/message event can't vacate it (SPEC-012). */
  private openGates = new Map<string, Set<string>>();
  /** SPEC-025: live repository identity + per-spec git/PR status, folded from repo.identity/repo.status. */
  private repoIdentity: RepoIdentityView | null = null;
  private repoStatusBySpec = new Map<string, RepoStatusView>();

  private gateOpen(sessionId: string, gateId: string): void {
    let s = this.openGates.get(sessionId);
    if (!s) this.openGates.set(sessionId, (s = new Set()));
    s.add(gateId);
  }
  private gateClose(sessionId: string, gateId: string): void {
    this.openGates.get(sessionId)?.delete(gateId);
  }
  private hasOpenGate(sessionId: string): boolean {
    return (this.openGates.get(sessionId)?.size ?? 0) > 0;
  }

  apply(event: DomainEvent): void {
    switch (event.type) {
      case "spec.status": {
        this.specStatus.set(event.specId, event.status);
        const card = this.ensureCard(event.specId);
        card.status = event.status;
        this.recompute(card);
        break;
      }
      case "spec.renamed": {
        // A blank-slate spec was renamed once titled (SPEC-020): re-key the card and the status map
        // from the old spec id to the new one so the board keeps tracking the same work.
        const oldId = event.oldSpecId;
        const newId = event.specId;
        if (oldId !== newId) {
          const st = this.specStatus.get(oldId);
          if (st !== undefined) {
            this.specStatus.delete(oldId);
            this.specStatus.set(newId, st);
          }
          const card = this.cards.get(oldId);
          if (card) {
            this.cards.delete(oldId);
            card.id = newId;
            card.specId = newId;
            if (card.title === oldId) card.title = newId;
            this.cards.set(newId, card);
            for (const s of card.sessions) this.sessionSpec.set(s.sessionId, newId);
          }
        }
        break;
      }
      case "session.status": {
        const card = this.ensureCard(event.specId);
        const s = this.ensureSession(card, event.sessionId, event.kind);
        s.status = event.status;
        s.model = event.model ?? s.model;
        s.harness = event.harness;
        // needsHuman is sticky while a permission/elicitation gate is open — a `running`/`idle`
        // status must not vacate needs-human out from under an open human decision (SPEC-012).
        s.needsHuman = event.status === "waiting" || this.hasOpenGate(event.sessionId);
        card.harness = event.harness ?? card.harness;
        card.model = event.model ?? card.model;
        this.recompute(card);
        break;
      }
      case "permission.asked": {
        // Only track a gate for a KNOWN session — a permission for an unknown session is discarded
        // (SPEC-012), so a ghost gate can't pin a card in needs-human forever.
        const card = this.cardForSession(event.sessionId);
        if (card) {
          this.gateOpen(event.sessionId, event.permissionId);
          this.sessionOf(card, event.sessionId)!.needsHuman = true;
          this.recompute(card);
        }
        break;
      }
      case "permission.replied": {
        this.gateClose(event.sessionId, event.permissionId);
        const card = this.cardForSession(event.sessionId);
        if (card) {
          this.sessionOf(card, event.sessionId)!.needsHuman = this.hasOpenGate(event.sessionId);
          this.recompute(card);
        }
        break;
      }
      case "elicitation.asked": {
        const card = this.cardForSession(event.sessionId);
        if (card) {
          this.gateOpen(event.sessionId, event.elicitationId);
          this.sessionOf(card, event.sessionId)!.needsHuman = true;
          this.recompute(card);
        }
        break;
      }
      case "elicitation.replied":
      case "elicitation.rejected": {
        this.gateClose(event.sessionId, event.elicitationId);
        const card = this.cardForSession(event.sessionId);
        if (card) {
          this.sessionOf(card, event.sessionId)!.needsHuman = this.hasOpenGate(event.sessionId);
          this.recompute(card);
        }
        break;
      }
      case "diff.finalized": {
        const s = this.sessionForId(event.sessionId);
        if (s) s.diff = { added: event.added, removed: event.removed, files: event.files };
        break;
      }
      case "repo.identity": {
        // SPEC-025: strip the event envelope; keep only the identity view the panel header renders.
        this.repoIdentity = { name: event.name, remote: event.remote, default: event.default, head: event.head };
        break;
      }
      case "repo.status": {
        this.repoStatusBySpec.set(event.specId, {
          specId: event.specId,
          branch: event.branch,
          ahead: event.ahead,
          behind: event.behind,
          dirty: event.dirty,
          added: event.added,
          removed: event.removed,
          files: event.files,
          pr: event.pr,
          ...(event.degraded ? { degraded: event.degraded } : {}),
        });
        break;
      }
      case "message.part":
        this.applyPart(event);
        break;
      case "message.updated":
        this.applyMessageUpdated(event);
        break;
      // turn.quiescent is a runtime receipt for consumers; it carries no read-model state change.
      // todo.updated / projection.write enrich detail views, not the board column here.
      default:
        break;
    }
  }

  snapshot(): CardState[] {
    return [...this.cards.values()];
  }

  /** SPEC-025: the current repository identity + per-spec status, for the connection snapshot so a
   *  freshly-connected client isn't blank until the next refresh. */
  repoSnapshot(): { repoIdentity: RepoIdentityView | null; gitBranches: RepoStatusView[] } {
    return { repoIdentity: this.repoIdentity, gitBranches: [...this.repoStatusBySpec.values()] };
  }

  /** SPEC-025: the specification a session folds into (populated on session.status), or undefined — so a
   *  repo-status recompute trigger can resolve a `diff.finalized`'s bare sessionId to its owning spec. */
  specForSession(sessionId: string): string | undefined {
    return this.sessionSpec.get(sessionId);
  }

  // ---- card / session helpers ----

  private ensureCard(specId: string): CardState {
    let card = this.cards.get(specId);
    if (!card) {
      card = {
        id: specId,
        specId,
        title: specId,
        column: "authoring",
        status: this.specStatus.get(specId) ?? "draft",
        needsHuman: false,
        sessions: [],
      };
      this.cards.set(specId, card);
    }
    return card;
  }

  private ensureSession(card: CardState, sessionId: string, kind: "spec" | "task"): SessionRef {
    this.sessionSpec.set(sessionId, card.specId);
    let s = card.sessions.find((x) => x.sessionId === sessionId);
    if (!s) {
      s = { sessionId, kind, status: "idle", needsHuman: false, transcript: [] };
      card.sessions.push(s);
    }
    return s;
  }

  /** The card owning a session, resolved via the session→spec index (populated on session.status). */
  private cardForSession(sessionId: string): CardState | undefined {
    const specId = this.sessionSpec.get(sessionId);
    return specId ? this.cards.get(specId) : undefined;
  }
  private sessionOf(card: CardState, sessionId: string): SessionRef | undefined {
    return card.sessions.find((s) => s.sessionId === sessionId);
  }
  private sessionForId(sessionId: string): SessionRef | undefined {
    const card = this.cardForSession(sessionId);
    return card ? this.sessionOf(card, sessionId) : undefined;
  }

  /** Recompute the card's aggregate `needsHuman` and `column` from all folded sessions (SPEC-023). */
  private recompute(card: CardState): void {
    card.needsHuman = card.sessions.some((s) => s.needsHuman);
    card.column = this.deriveColumn(card);
  }

  /**
   * Compute the board column from the specification status and the aggregate of its sessions (FR-9,
   * SPEC-023). Precedence: any open human gate or any FAILED delivery session → needs-human; else any
   * running-or-idle delivery session → implementing; else any done delivery session → diff; else the
   * spec's frontmatter status. Only `task` (delivery) sessions drive implementing/diff — an authoring
   * session running during `draft` keeps the card in `authoring`.
   *
   * `idle` counts as implementing, not just `running` (SPEC-028): a single-session delivery may take
   * several human-steered turns, and OpenCode's own turn-settle ordering emits `session.status: idle`
   * BEFORE the non-streaming `message.updated` the completion oracle (`observeDeliveryProgress`) reads —
   * so an in-progress, steerable delivery sits in `idle` between turns whenever its checklist isn't yet
   * complete. Treating idle as anything but `implementing` would bounce the card back to the spec's
   * `approved` backlog lane mid-delivery. Once the checklist actually IS complete, the coordinator emits
   * an explicit `done` status that takes over on the very next recompute.
   */
  private deriveColumn(card: CardState): BoardColumn {
    const tasks = card.sessions.filter((s) => s.kind === "task");
    if (card.needsHuman || tasks.some((s) => FAILED_STATUSES.has(s.status))) return "needs-human";
    if (tasks.some((s) => s.status === "running" || s.status === "idle")) return "implementing";
    if (tasks.some((s) => s.status === "done")) return "diff";
    switch (card.status) {
      case "draft":
        return "authoring";
      case "in-review":
        return "review";
      case "approved":
        return "approved";
      case "delivered":
        return "delivered";
      default:
        return "authoring";
    }
  }

  // ---- transcript folding (per session; does NOT affect column) ----

  private applyPart(event: Extract<DomainEvent, { type: "message.part" }>): void {
    const s = this.sessionForId(event.sessionId);
    if (!s) return; // a part for a session we have no card for is ignored, not buffered
    const entry = this.ensureTranscriptEntry(s, event.messageId, event.role);

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
    const s = this.sessionForId(event.sessionId);
    if (!s) return;
    const entry = this.ensureTranscriptEntry(s, event.messageId, event.role);
    entry.text = event.text;
    entry.toolCalls = event.toolCalls;
    entry.role = event.role;
    entry.isStreaming = event.isStreaming;
    this.bufferFor(event.sessionId).delete(event.messageId);
  }

  private ensureTranscriptEntry(
    session: SessionRef,
    messageId: string,
    role: TranscriptEntry["role"],
  ): TranscriptEntry {
    let entry = session.transcript.find((t) => t.messageId === messageId);
    if (!entry) {
      entry = { messageId, role, text: "", toolCalls: [], isStreaming: true };
      session.transcript.push(entry);
      if (session.transcript.length > MAX_TRANSCRIPT) session.transcript.shift();
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
}
