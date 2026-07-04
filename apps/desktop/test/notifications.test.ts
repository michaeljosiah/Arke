import assert from "node:assert/strict";
import { test } from "node:test";
import { NotificationRouter } from "../src/notifications.js";

test("permission.asked → one notification; a reconnect replay does not re-fire", () => {
  const r = new NotificationRouter();
  const first = r.onEvent({ type: "permission.asked", permissionId: "perm-1" });
  assert.ok(first);
  assert.equal(first!.kind, "permission");
  assert.equal(first!.view, "cockpit");
  assert.doesNotMatch(first!.body, /SPEC|spec-|secret/i); // content-free
  // the fresh snapshot on reconnect re-delivers the still-open permission → no second notification
  assert.equal(r.onEvent({ type: "permission.asked", permissionId: "perm-1" }), null);
});

test("permission.replied prunes the id so a later re-raise notifies again", () => {
  const r = new NotificationRouter();
  assert.ok(r.onEvent({ type: "permission.asked", permissionId: "perm-1" }));
  assert.equal(r.onEvent({ type: "permission.replied", permissionId: "perm-1" }), null); // prune
  assert.ok(r.onEvent({ type: "permission.asked", permissionId: "perm-1" }), "re-raise after resolve notifies");
});

test("elicitation.asked (NOT question.asked) is the trigger, keyed on elicitationId", () => {
  const r = new NotificationRouter();
  // OpenCode's raw name never reaches the router → no notification
  assert.equal(r.onEvent({ type: "question.asked" } as any), null);
  const n = r.onEvent({ type: "elicitation.asked", elicitationId: "el-9" });
  assert.ok(n);
  assert.equal(n!.kind, "elicitation");
  // resolve via replied OR rejected prunes it
  assert.equal(r.onEvent({ type: "elicitation.rejected", elicitationId: "el-9" }), null);
  assert.ok(r.onEvent({ type: "elicitation.asked", elicitationId: "el-9" }));
});

test("a task session.status waiting|error notifies needs-human; leaving it prunes", () => {
  const r = new NotificationRouter();
  assert.equal(r.onEvent({ type: "session.status", sessionId: "s1", kind: "spec", status: "waiting" }), null); // only tasks
  const w = r.onEvent({ type: "session.status", sessionId: "s2", kind: "task", status: "waiting" });
  assert.ok(w);
  assert.equal(w!.view, "board");
  assert.equal(r.onEvent({ type: "session.status", sessionId: "s2", kind: "task", status: "waiting" }), null); // dedup
  // the task resumes → prune, so a later error re-notifies
  assert.equal(r.onEvent({ type: "session.status", sessionId: "s2", kind: "task", status: "running" }), null);
  assert.ok(r.onEvent({ type: "session.status", sessionId: "s2", kind: "task", status: "error" }));
});

test("panel.complete / config-error notify by panelId", () => {
  const r = new NotificationRouter();
  const done = r.onEvent({ type: "panel.complete", panelId: "p1" });
  assert.ok(done);
  assert.equal(done!.view, "review");
  assert.match(done!.body, /finished/);
  assert.equal(r.onEvent({ type: "panel.complete", panelId: "p1" }), null); // dedup
  const failed = r.onEvent({ type: "panel.config-error", panelId: "p2" });
  assert.match(failed!.body, /could not run/);
});

test("mute suppresses the raised notification but still de-dups + prunes", () => {
  const r = new NotificationRouter();
  r.setMuted(true);
  assert.equal(r.onEvent({ type: "permission.asked", permissionId: "perm-1" }), null); // suppressed
  r.setMuted(false);
  // it was recorded while muted, so unmuting does not replay the already-seen gate
  assert.equal(r.onEvent({ type: "permission.asked", permissionId: "perm-1" }), null);
});

test("unrelated events never notify", () => {
  const r = new NotificationRouter();
  for (const type of ["registry.updated", "message.updated", "diff.finalized", "turn.quiescent"]) {
    assert.equal(r.onEvent({ type }), null);
  }
});
