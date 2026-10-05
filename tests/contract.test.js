import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent, validateStream, EVENT_TYPES } from "../src/validator.js";

const base = {
  event_id: "evt-test-0001",
  event_type: "DESIGN_SUBMITTED",
  aggregate_type: "design_revision",
  aggregate_id: "site-1",
  occurred_at: "2026-09-20T12:00:00+08:00",
  version: 1,
  summary: "提交设计图纸 R1",
  payload: {},
};

test("信封：合法事件通过", () => {
  assert.deepEqual(validateEvent(base), []);
});

test("信封：缺少字段逐项报中文错误", () => {
  const errors = validateEvent({});
  assert.ok(errors.some((m) => m.includes("event_id")));
  assert.ok(errors.length >= 7);
});

test("信封：事件类型必须挂到指定聚合，多部门补件不得新开聚合", () => {
  const wrong = validateEvent({ ...base, event_type: "OPENING_DECIDED", aggregate_type: "design_revision" });
  assert.ok(wrong.some((m) => m.includes("必须挂在聚合")));
  const unknownAgg = validateEvent({ ...base, aggregate_type: "enrollment_page" });
  assert.ok(unknownAgg.some((m) => m.includes("不支持的聚合类型")));
});

test("信封：occurred_at 必须带时区，version 必须正整数", () => {
  assert.ok(validateEvent({ ...base, occurred_at: "2026-09-20 12:00:00" }).some((m) => m.includes("ISO")));
  assert.ok(validateEvent({ ...base, version: 0 }).some((m) => m.includes("version")));
});

test("事件流：event_id 重复、版本不连续都报错", () => {
  const events = [
    { ...base, event_id: "evt-a1-0001", version: 1 },
    { ...base, event_id: "evt-a1-0002", version: 2 },
    { ...base, event_id: "evt-a1-0002", version: 3 },
  ];
  const errors = validateStream(events);
  assert.ok(errors.some((m) => m.includes("重复")));
  const badVersion = validateStream([{ ...base, version: 3 }]);
  assert.ok(badVersion.some((m) => m.includes("期望 1")));
});

test("事件流：不同聚合流各自从 1 计版本", () => {
  const events = [
    { ...base, version: 1 },
    { ...base, event_type: "OPENING_DECIDED", aggregate_type: "opening_decision", version: 1, event_id: "evt-a1-0002" },
    { ...base, version: 2, event_id: "evt-a1-0003" },
  ];
  assert.deepEqual(validateStream(events), []);
});

test("样例事件流通过信封与版本校验", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(sample.events) && sample.events.length >= 20);
  assert.deepEqual(validateStream(sample.events), []);
  for (const event of sample.events) assert.ok(EVENT_TYPES.includes(event.event_type));
});

test("契约：schema 是结构合法的 JSON，事件类型与校验器一致", async () => {
  const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
  assert.deepEqual([...schema.properties.event_type.enum].sort(), [...EVENT_TYPES].sort());
  assert.equal(schema.oneOf.length, EVENT_TYPES.length);
});
