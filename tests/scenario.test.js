import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  allowedPublishedCapacity,
  auditDecision,
  auditPublication,
  gates,
  project,
  reworkLedger,
  termView,
} from "../src/project.js";
import {
  checkCapacityPublished,
  checkExitPlan,
  checkHandback,
  checkOpeningDecision,
} from "../src/commands.js";

async function loadSample() {
  return JSON.parse(await readFile(new URL("../data/sample-stream.json", import.meta.url), "utf8"));
}

test("场景：开放日时午睡区在整改，系统只允许活动室局部开放", async () => {
  const state = project(await loadSample());
  const g = gates(state, "2026-09-27T12:00:00+08:00");
  assert.equal(g.opening.status, "not_allowed"); // 决定签署前
  assert.deepEqual(g.opening.open_zones, []);

  // 流末：仅活动室开放
  const after = gates(state);
  assert.equal(after.opening.status, "partial");
  assert.deepEqual(after.opening.open_zones, ["Z-PLAY"]);

  // 午睡区带严重缺陷试图开放 -> 被拒
  const rejected = checkOpeningDecision(state, {
    kind: "partial",
    decided_at: "2026-10-05T16:00:00+08:00",
    decision_ref: "OD-BAD",
    signed_by: { name: "某人" },
    basis_revision_no: 2,
    zones_requested: ["Z-NAP"],
    basis_refs: ["FI-2026-1004", "HE-2026-1004", "MT-2026-1003"],
    evidence_refs: ["EV-x.jpg"],
    conditions: ["先收托再说"],
  });
  assert.match(rejected.join("；"), /严重缺陷|分区验收签署/);
});

test("场景：R2 修订（午睡区疏散+材料）精确命中须重做的检查，活动室不受牵连", async () => {
  const state = project(await loadSample());
  const ledger = reworkLedger(state);
  assert.equal(ledger.length, 1);
  const zones = new Set(ledger[0].rework_required.map((r) => r.zone_id));
  assert.deepEqual([...zones], ["Z-NAP"]);
  const refs = ledger[0].rework_required.map((r) => r.invalidated_ref).sort();
  assert.deepEqual(refs, ["F-NAP-01", "F-NAP-02", "FI-2026-0412", "HE-2026-0413", "MT-2026-0410"]);
});

test("场景：已发布的招生页面（25 人）合规；按整栋满额发布被拒", async () => {
  const state = project(await loadSample());
  const pub = state.publications[0];
  assert.deepEqual(auditPublication(state, pub), []);
  assert.equal(allowedPublishedCapacity(state).total, 25);

  assert.match(
    checkCapacityPublished(state, {
      published_at: "2026-10-05",
      page_ref: "https://example.org/admission/huaixiangli",
      zones_included: ["Z-NAP", "Z-PLAY", "Z-CARE"],
      published_capacity: 140,
    }).join("；"),
    /获准|备案容量合计/,
  );
});

test("场景：产权两年期已登记，退出方案提前形成且四要素责任清晰", async () => {
  const events = await loadSample();
  const state = project(events);
  const term = termView(state);
  assert.equal(term.term_end, "2028-10-31");
  assert.equal(term.exit_plan.plan_ref, "EX-2026-10-01");
  assert.equal(term.exit_plan.child_placement.responsible_party.includes("专班"), true);

  const planEvent = events.find((e) => e.event_type === "EXIT_PLAN_FORMED").payload;
  assert.deepEqual(checkExitPlan(state, planEvent), []);
});

test("场景：历史开园决定 OD-2026-09-01 引用的全部文书在决定日均有效", async () => {
  const state = project(await loadSample());
  const decision = state.openings[0];
  assert.ok(decision.evidence_refs.length >= 1);
  assert.ok(decision.signed_by.name);
  assert.ok(decision.conditions.some((c) => c.includes("午睡区")));
  // 事后稽核：不允许过期或旧版次文书蒙混进决定依据
  assert.deepEqual(auditDecision(state, decision), []);
});

test("场景：交还场地必须等儿童安置与恢复确认", async () => {
  const state = project(await loadSample());
  assert.match(
    checkHandback(state, {
      handed_back_at: "2028-09-30",
      handover_ref: "HB-1",
      restoration_confirmed_by: null,
      children_settled: false,
    }).join("；"),
    /恢复须经产权单位确认|未完成安置/,
  );
});
