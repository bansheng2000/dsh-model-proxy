// 自检：节点池（排序 / 失败降级 / 切换限流 / 巡检）。假 adapter，不联网。
import assert from "node:assert/strict";
import { createNodePool, POOL_DEFAULTS } from "../lib/nodes.js";

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; process.stdout.write("PASS " + label + "\n"); };
const eq = async (label, fn) => { await fn(); checks += 1; process.stdout.write("PASS " + label + "\n"); };

/** 可控时钟 + 可控 adapter：delay/select 行为由测试安排。 */
function makePool(options = {}) {
  const clock = { t: 1_000_000 };
  const calls = { select: [], delay: [] };
  const healthy = new Set(options.healthy ?? []);
  const adapter = {
    async delay(name) {
      calls.delay.push(name);
      return healthy.has(name) ? { ok: true, latencyMs: 50 } : { ok: false, code: "timeout", message: "超时" };
    },
    async select(name) {
      calls.select.push(name);
      return { ok: true, value: { selected: name } };
    },
  };
  const pool = createNodePool({ adapter, now: () => clock.t, tuning: options.tuning });
  pool.setNodes(options.nodes ?? [
    { name: "A", protocol: "vless", server: "a", port: 443 },
    { name: "B", protocol: "hysteria2", server: "b", port: 443 },
    { name: "C", protocol: "vless", server: "c", port: 443 },
  ]);
  return { pool, clock, calls, healthy };
}

await eq("初始排序：都没测过时按名字稳定返回，best 不返回失败节点", async () => {
  const { pool } = makePool();
  assert.equal(pool.size, 3);
  assert.equal(pool.snapshot().current, null);
  assert.equal(pool.best(null).name, "A");
});

await eq("测速后按延迟排序，失败节点排最后", async () => {
  const { pool } = makePool();
  await pool.markOk("A", 300);
  await pool.markOk("B", 80);
  pool.markFailed("C");
  assert.deepEqual(pool.snapshot().nodes.map((n) => n.name), ["B", "A", "C"]);
  assert.equal(pool.best(null).name, "B");
});

await eq("切换成功会调 adapter.select 并记录当前节点", async () => {
  const { pool, calls } = makePool();
  await pool.markOk("B", 80);
  const result = await pool.switchTo("B", "手动");
  assert.equal(result.ok, true);
  assert.deepEqual(calls.select, ["B"]);
  assert.equal(pool.current, "B");
});

await eq("同节点重复切换直接拒绝", async () => {
  const { pool, calls } = makePool();
  await pool.switchTo("A", "手1");
  const again = await pool.switchTo("A", "手2");
  assert.equal(again.ok, false);
  assert.equal(again.code, "already-current");
  assert.equal(calls.select.length, 1);
});

await eq("minSwitchGapMs 内的自动切换被挡住，时钟越过后就放行", async () => {
  const { pool, clock } = makePool();
  await pool.switchTo("A", "手1");
  clock.t += 5_000;
  const blocked = await pool.switchTo("B", "太快");
  assert.equal(blocked.code, "too-soon");
  clock.t += POOL_DEFAULTS.minSwitchGapMs;
  const allowed = await pool.switchTo("B", "够了");
  assert.equal(allowed.ok, true);
});

await eq("每小时切换次数封顶", async () => {
  const { pool, clock } = makePool({ tuning: { maxSwitchesPerHour: 2 } });
  for (let i = 0; i < 2; i += 1) {
    const target = ["A", "B", "C"][i];
    const result = await pool.switchTo(target, "循环");
    assert.equal(result.ok, true);
    clock.t += POOL_DEFAULTS.minSwitchGapMs + 1;
  }
  const limited = await pool.switchTo("A", "超额");
  assert.equal(limited.code, "rate-limited");
});

await eq("failover：标记当前失败并切到下一个", async () => {
  const { pool, calls, clock } = makePool();
  await pool.markOk("A", 100);
  await pool.markOk("B", 200);
  await pool.switchTo("A", "初始");
  clock.t += POOL_DEFAULTS.minSwitchGapMs + 1;
  const result = await pool.failover("请求失败");
  assert.equal(result.ok, true);
  assert.equal(result.value.name, "B");
  assert.deepEqual(calls.select, ["A", "B"]);
  const a = pool.snapshot().nodes.find((n) => n.name === "A");
  assert.equal(a.ok, false);
});

await eq("failover 无可用节点时返回 no-healthy-node", async () => {
  const { pool } = makePool();
  pool.setNodes([{ name: "A" }]);
  await pool.switchTo("A", "初始").catch(() => {});
  pool.markFailed("A");
  const result = await pool.failover("挂了");
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-healthy-node");
});

await eq("巡检：第一次失败只记数，连续两次才切换", async () => {
  const { pool, clock } = makePool({ healthy: ["B"] });
  pool.setNodes([{ name: "A" }, { name: "B" }]);
  await pool.switchTo("A", "初始");
  const first = await pool.probeTick();
  assert.equal(first.ok, false);
  assert.equal(first.code, "probe-failed");
  assert.equal(pool.current, "A");
  clock.t += POOL_DEFAULTS.minSwitchGapMs + 1;
  const second = await pool.probeTick();
  assert.equal(second.ok, true);
  assert.equal(pool.current, "B");
});

await eq("testAll 只测已有节点并更新快照", async () => {
  const { pool, calls } = makePool({ healthy: ["A", "C"] });
  const result = await pool.testAll();
  assert.equal(result.value.length, 3);
  assert.equal(calls.delay.length, 3);
  const snapshot = pool.snapshot();
  assert.equal(snapshot.nodes.find((n) => n.name === "B").ok, false);
  assert.equal(snapshot.nodes.find((n) => n.name === "A").latencyMs, 50);
});

await eq("setNodes 刷新订阅时保留已有健康度", async () => {
  const { pool } = makePool();
  await pool.markOk("A", 42);
  pool.setNodes([{ name: "A" }, { name: "D" }]);
  assert.equal(pool.size, 2);
  assert.equal(pool.snapshot().nodes.find((n) => n.name === "A").latencyMs, 42);
});

// 落盘的健康度能被恢复：重启后界面立刻有延迟/可用状态，不用先测一轮
ok("restoreRows 恢复延迟与健康度", () => {
  const { pool } = makePool();
  pool.restoreRows([
    { name: "A", latencyMs: 120, ok: true, failures: 0, streak: 0, lastTestAt: 111 },
    { name: "B", latencyMs: null, ok: false, failures: 3, streak: 2, lastTestAt: 222 },
  ]);
  const snap = pool.snapshot();
  const a = snap.nodes.find((n) => n.name === "A");
  const b = snap.nodes.find((n) => n.name === "B");
  assert.equal(a.latencyMs, 120);
  assert.equal(a.ok, true);
  assert.equal(a.lastTestAt, 111);
  assert.equal(b.ok, false);
  assert.equal(b.failures, 3);
  assert.equal(b.streak, 2);
  // 缓存里没见过的名字不许凭空造节点
  const before = pool.size;
  pool.restoreRows([{ name: "D", latencyMs: 9 }]);
  assert.equal(pool.size, before);
});

process.stdout.write("nodes: " + checks + " checks passed\n");
