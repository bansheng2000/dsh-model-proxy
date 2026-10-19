/**
 * 自检：代理不通时自动改直连（failover）。
 * 用 DSH 自带 Node 运行，不依赖宿主、不需要墙外网络：node test/failover.mjs
 *
 * 直接测 installProxyDispatcher（不经过 policy），因为 policy 对回环地址恒判直连，
 * 而这里要的正是「判定为走代理」的那条路。origin 用本地 http 服务，代理指向没人监听的
 * 端口 1（立即 ECONNREFUSED，不用等超时）。
 *
 * 覆盖：
 *  - 代理连不上 → 改直连重发：原请求成功、body 完整、目标只收到 1 次、业务侧无感
 *  - 降级后 health=down，记一次重试与 proxy-failed / fallback 事件
 *  - 冷却期内继续直连，不再撞代理、不再产生重试
 *  - 冷却到期后放一个请求试探，仍不通则继续直连并加倍冷却
 *  - 卸载后恢复直连
 *  - 状态机纯逻辑：退避翻倍/封顶、单试探、恢复清零、事件环形缓冲
 */
import assert from "node:assert/strict";
import http from "node:http";

import { fetch as undiciFetch } from "undici";

import { FAILOVER, createProxyHealth, installProxyDispatcher } from "../lib/dispatcher.js";

const failures = [];
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log("PASS " + name);
  } catch (error) {
    failures.push(name + ": " + (error && error.message ? error.message : error));
    console.log("FAIL " + name + " — " + (error && error.message ? error.message : error));
  }
}

const DEAD_PROXY = "http://127.0.0.1:1"; // 没人监听：连不上，且立即失败（不用等超时）

/** 起一个本地 origin，记录收到的每个请求。 */
async function startOrigin() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("origin-ok");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, seen };
}

// ── 实跑 ─────────────────────────────────────────────────────────────────────
const origin = await startOrigin();
const events = [];
const decisions = [];
const health = createProxyHealth({ cooldownMs: 1000, onEvent: (e) => events.push(e) });
const dispose = await installProxyDispatcher({
  proxyUrl: DEAD_PROXY,
  decide: () => true,
  onDecision: (d) => decisions.push(d),
  health,
});
const url = (path) => "http://127.0.0.1:" + origin.port + path;

await test("代理连不上时自动改直连：请求成功、body 完整、目标只收到 1 次", async () => {
  const response = await undiciFetch(url("/hello"), { method: "POST", body: "payload-123" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "origin-ok");
  assert.equal(origin.seen.length, 1, "目标应只收到 1 次请求，实际 " + origin.seen.length);
  assert.equal(origin.seen[0].body, "payload-123", "请求体应完整送达");
  assert.equal(origin.seen[0].method, "POST");
  assert.ok(decisions.length >= 1, "判定器应被调用");
  assert.equal(decisions[0].proxied, true);
});

await test("降级后 health=down，记一次重试与 proxy-failed / fallback 事件", () => {
  const snapshot = health.snapshot;
  assert.equal(snapshot.state, "down");
  assert.equal(snapshot.retries, 1);
  assert.equal(snapshot.failures, 1);
  assert.equal(snapshot.lastError, "ECONNREFUSED");
  assert.ok(snapshot.directRemainingMs > 0 && snapshot.directRemainingMs <= 1000, "冷却剩余 " + snapshot.directRemainingMs);
  assert.equal(snapshot.thresholds.attemptTimeoutMs, FAILOVER.attemptTimeoutMs);
  assert.equal(snapshot.thresholds.cooldownMs, 1000);
  assert.ok(events.some((e) => e.type === "proxy-failed"), "应有 proxy-failed 事件");
  assert.ok(events.some((e) => e.type === "fallback"), "应有 fallback 事件");
});

await test("冷却期内直接直连，不再撞代理、不再重试", async () => {
  const before = health.snapshot;
  const response = await undiciFetch(url("/again"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "origin-ok");
  const after = health.snapshot;
  assert.equal(after.retries, before.retries, "冷却期内不应再产生重试");
  assert.equal(after.failures, before.failures, "冷却期内不应再判定失败");
  assert.ok(after.directRouted > before.directRouted, "应计入直连路由");
  assert.equal(origin.seen.length, 2);
});

await test("冷却到期后只放一个请求试探，仍不通则继续直连并加倍冷却", async () => {
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const before = health.snapshot;
  assert.equal(before.directRemainingMs, 0, "冷却应已到期");
  const response = await undiciFetch(url("/probe"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "origin-ok");
  const after = health.snapshot;
  assert.equal(after.state, "down");
  assert.equal(after.failures, before.failures + 1, "试探应重新判定一次失败");
  assert.equal(after.retries, before.retries + 1);
  assert.equal(after.nextCooldownMs, 2000, "连续失败应翻倍冷却，实际 " + after.nextCooldownMs);
  assert.equal(origin.seen.length, 3, "目标仍应只收到试探失败后重发的那一次");
});

await dispose();

await test("卸载后恢复直连，且不再有降级状态", async () => {
  const response = await undiciFetch(url("/after-dispose"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "origin-ok");
  assert.equal(origin.seen.length, 4);
  assert.equal(health.snapshot.retries, 2, "卸载后不再产生降级");
});

// ── 纯逻辑：健康状态机 ───────────────────────────────────────────────────────
await test("状态机：失败退避翻倍并封顶，恢复后清零", () => {
  let clock = 0;
  const state = createProxyHealth({ cooldownMs: 100, maxCooldownMs: 500, now: () => clock });
  assert.equal(state.tryProxy(), true);

  assert.equal(state.failed({ origin: "http://a", code: "ECONNREFUSED" }), 100);
  assert.equal(state.snapshot.nextCooldownMs, 100);
  assert.equal(state.tryProxy(), false, "冷却中应直连");

  clock = 100;
  assert.equal(state.tryProxy(), true, "到期后放一个试探");
  assert.equal(state.tryProxy(), false, "试探在飞时其余请求直连");

  state.failed({ origin: "http://a", code: "ECONNREFUSED" });
  assert.equal(state.snapshot.failures, 2);
  assert.equal(state.snapshot.nextCooldownMs, 200);

  clock = 300;
  assert.equal(state.tryProxy(), true);
  state.failed({ origin: "http://a", code: "ECONNREFUSED" });
  assert.equal(state.snapshot.nextCooldownMs, 400);

  clock = 700;
  assert.equal(state.tryProxy(), true);
  state.failed({ origin: "http://a", code: "ECONNREFUSED" });
  assert.equal(state.snapshot.nextCooldownMs, 500, "应封顶 maxCooldownMs");

  state.succeeded("http://a");
  assert.equal(state.snapshot.state, "up");
  assert.equal(state.snapshot.failures, 0);
  assert.equal(state.snapshot.nextCooldownMs, 100);
  assert.ok(state.events.some((e) => e.type === "recovered"), "应有 recovered 事件");
});

await test("状态机：事件环形缓冲不超过上限", () => {
  let clock = 0;
  const state = createProxyHealth({ now: () => clock });
  for (let i = 0; i < FAILOVER.logLimit + 10; i += 1) {
    clock = i * 10;
    state.failed({ origin: "http://a", code: "ECONNRESET" });
    state.fallback("http://a");
  }
  assert.equal(state.events.length, FAILOVER.logLimit);
  assert.equal(state.snapshot.events.length, FAILOVER.logLimit);
});

// ── 收尾 ─────────────────────────────────────────────────────────────────────
origin.server.close();
console.log("");
if (failures.length === 0) {
  console.log("通过 " + passed + " 项断言");
  console.log("全部通过 ✅");
  process.exit(0);
}
console.log("失败 " + failures.length + " 项：");
for (const message of failures) console.log(" - " + message);
process.exit(1);
