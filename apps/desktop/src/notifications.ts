// Notification router (SPEC-022) — the PURE mapping from coordinator stream events to OS notifications.
// Kept free of Electron so it is fully unit-testable; `main.ts` wires its output to `new Notification()`.
//
// Grounding (SPEC-022 review round 2): the triggers are the CANONICAL normalised domain events the
// renderer/coordinator emit — `permission.asked` / `elicitation.asked` (NOT OpenCode's raw
// `question.asked`), a task `session.status` of `waiting` (blocked on a human) or `error` (failed), and
// `panel.complete` / `panel.config-error` / `panel.reviewer-error`. Because SPEC-003 restarts `seq` on
// reconnect and re-delivers open gates in the fresh snapshot, notifications are de-duplicated by a
// stable domain id and PRUNED when the gate resolves, so a reconnect never re-fires and a later,
// legitimately re-raised gate reusing an id still notifies.

/** A minimal view of a normalised domain event — only the fields the router reads. */
export interface RouterEvent {
  type: string;
  permissionId?: string;
  elicitationId?: string;
  sessionId?: string;
  panelId?: string;
  /** For `session.status`: the session's lifecycle status and kind. */
  status?: string;
  kind?: string;
}

/** A notification the shell should raise (content-free body — never spec text or a secret). */
export interface DesktopNotification {
  /** The dedup class: `permission` | `elicitation` | `needs-human` | `review`. */
  kind: string;
  /** The stable domain id used for dedup + prune. */
  id: string;
  title: string;
  body: string;
  /** The client view to navigate to when the notification is clicked. */
  view: string;
}

const dedupKey = (kind: string, id: string) => `${kind}:${id}`;

/**
 * Maps stream events to at most one notification each, de-duplicating by `{kind, domain-id}` and
 * pruning that id when the gate resolves. Stateless about the domain otherwise; one instance per app run.
 */
export class NotificationRouter {
  private readonly notified = new Set<string>();
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * Feed one event. Returns the notification to raise, or null (a resolve/prune, a duplicate, a muted
   * alert, or an untriggered event). Pruning happens even while muted, so the dedup set stays correct.
   */
  onEvent(ev: RouterEvent): DesktopNotification | null {
    // ---- resolutions: prune the corresponding id so a later re-raise notifies again ----
    switch (ev.type) {
      case "permission.replied":
        if (ev.permissionId) this.notified.delete(dedupKey("permission", ev.permissionId));
        return null;
      case "elicitation.replied":
      case "elicitation.rejected":
        if (ev.elicitationId) this.notified.delete(dedupKey("elicitation", ev.elicitationId));
        return null;
      case "session.status":
        // A task leaving waiting/error is resolved — prune so a future waiting/error re-notifies.
        if (ev.sessionId && ev.status && ev.status !== "waiting" && ev.status !== "error") {
          this.notified.delete(dedupKey("needs-human", ev.sessionId));
          return null;
        }
        break;
    }

    const candidate = this.map(ev);
    if (!candidate) return null;
    const key = dedupKey(candidate.kind, candidate.id);
    if (this.notified.has(key)) return null; // already notified for this open gate (e.g. reconnect replay)
    this.notified.add(key);
    if (this.muted) return null; // recorded for dedup, but suppressed
    return candidate;
  }

  /** The trigger → notification mapping (content-free bodies). Returns null for non-trigger events. */
  private map(ev: RouterEvent): DesktopNotification | null {
    switch (ev.type) {
      case "permission.asked":
        return ev.permissionId
          ? { kind: "permission", id: ev.permissionId, title: "Arke", body: "A decision is waiting for you.", view: "cockpit" }
          : null;
      case "elicitation.asked":
        return ev.elicitationId
          ? { kind: "elicitation", id: ev.elicitationId, title: "Arke", body: "An agent is asking you a question.", view: "cockpit" }
          : null;
      case "session.status":
        // A task blocked on a human (`waiting`) or failed (`error`) needs attention (SPEC-009).
        return ev.sessionId && ev.kind === "task" && (ev.status === "waiting" || ev.status === "error")
          ? { kind: "needs-human", id: ev.sessionId, title: "Arke", body: "A task needs your attention.", view: "board" }
          : null;
      case "panel.complete":
      case "panel.config-error":
      case "panel.reviewer-error":
        return ev.panelId
          ? { kind: "review", id: ev.panelId, title: "Arke", body: ev.type === "panel.complete" ? "A review finished." : "A review could not run.", view: "review" }
          : null;
      default:
        return null;
    }
  }
}
