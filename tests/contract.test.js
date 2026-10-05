import assert from "node:assert/strict";
import test from "node:test";

import { validateEvent, validateStream } from "../src/validator.js";
import { readFile } from "node:fs/promises";

test("信封：事件必须落在所属聚合，禁止跨聚合登记", () => {
  const record = {
    event_id: "evt-00000001",
    event_type: "DESIGN_APPROVED",
    aggregate_type: "property_term", // 错误归属
    aggregate_id: "x",
    occurred_at: "2027-01-01T00:00:00+08:00",
    version: 1,
    summary: "测试事件",
    payload: { site_id: "x" },
  };
  assert.ok(validateEvent(record).some((e) => e.includes("必须登记在聚合 design_revision")));

  record.aggregate_type = "design_revision";
  // 缺必填负载
  assert.ok(validateEvent(record).some((e) => e.includes("负载缺少必填字段")));
});

test("流：event_id 不得重复、聚合内 version 必须连续", () => {
  const mk = (id, version) => ({
    event_id: id,
    event_type: "TERM_REGISTERED",
    aggregate_type: "property_term",
    aggregate_id: "site-x",
    occurred_at: "2027-01-01T00:00:00+08:00",
    version,
    summary: "登记场地期限记录",
    payload: {
      site_id: "site-x",
      owner: "o",
      original_use: "仓",
      term_start: "2027-01-01",
      term_end: "2030-01-01",
    },
  });
  const errors = validateStream([mk("evt-dup-01", 1), mk("evt-dup-01", 2)]);
  assert.ok(errors.some((e) => e.includes("event_id 重复")));

  const gap = validateStream([mk("evt-ok-0001", 1), mk("evt-ok-0002", 3)]);
  assert.ok(gap.some((e) => e.includes("版本不连续")));
});

test("完整样例事件流通过校验", async () => {
  const events = JSON.parse(await readFile(new URL("../data/sample-stream.json", import.meta.url), "utf8"));
  assert.deepEqual(validateStream(events), []);
});
