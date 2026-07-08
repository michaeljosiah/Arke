import assert from "node:assert/strict";
import { test } from "node:test";
import { store } from "../src/store";
import { setAutoOpenPr } from "../src/live";

// SPEC-030: the Settings auto-PR toggle optimistically flips the store for snappiness, but a refused/
// failed persist (e.g. offline — no transport is connected in a unit test) must ROLL BACK, so the toggle
// never reads "on" while the project config still says false. It also surfaces the failure as a notice.

test("setAutoOpenPr rolls back the optimistic toggle and surfaces a notice when the write is refused offline", async () => {
  store.set({ autoOpenPr: false, cockpit: { queued: 0, notice: null } });

  const res = await setAutoOpenPr(true);

  assert.equal(res.ok, false, "an offline governed write is refused, not silently accepted");
  assert.equal(store.get().autoOpenPr, false, "the toggle rolled back to its previous value — not left optimistically on");
  assert.match(store.get().cockpit.notice ?? "", /auto-PR/i, "the failure is surfaced to the user");
});
