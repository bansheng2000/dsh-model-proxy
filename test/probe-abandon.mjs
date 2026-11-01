/**
 * 自检：降级期的「试探」被打断后，不能把代理永久钉在直连。
 *
 * 回归的 bug：dispatch 只在 retryable（未交付 + 白名单错误码）时调 proxyHealth.failed()，
 * 而 probeInFlight 只有 succeeded() / failed() 会清。于是「试探请求被调用方 abort」
 * 或「已连上、响应头之前失败（证书错等）」这两条路径会让 probeInFlight 永远为 true，
 * tryProxy() 的条件永假 —— 此后所有请求都直连，直到进程重启。
 *
 * 这个测试用 test/undici-stub.mjs 顶掉 undici，直接对 Router 喂事件，不需要网络：
 * 修复前第二条断言（probeInFlight 应为 false）会失败，修复后通过。
 *
 * 运行：node test/probe-abandon.mjs
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register("./undici-hook.mjs", import.meta.url);
// 必须动态 import：静态 import 会在 register 之前就把真 undici 求值了（见 undici-hook.mjs）
const stub = await import("./undici-stub.mjs");
const { createProxyHealth, installProxyDispatcher } = await import("../lib/dispatcher.js");

let passed = 0;
const failures = [];
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

const ORIGIN = "http://llm.example.test:443";
const health = createProxyHealth({ cooldownMs: 0, maxCooldownMs: 0 });
const dispose = await installProxyDispatcher({ proxyUrl: "http://127.0.0.1:1", decide: () => true, health });

const agent = stub.currentDispatcher();
assert.equal(typeof agent?.options?.factory, "function", "stub 的 Agent 应保留 factory，才能拿到 Router");
const router = agent.options.factory(ORIGIN, {});

/** 发一次请求；返回收集到的事件与错误（错误必须原样到调用方，不能被吞）。 */
function dispatchOnce() {
  const seen = { connect: 0, headers: 0, error: null };
  router.dispatch(
    { origin: ORIGIN, path: "/v1/chat/completions", method: "GET" },
    {
      onConnect() {
        seen.connect += 1;
      },
      onHeaders() {
        seen.headers += 1;
      },
      onData() {},
      onComplete() {},
      onError(error) {
        seen.error = error;
      },
    },
  );
  return seen;
}

/** 同上，但等一轮宏任务：降级重发是排在微任务里的（见 #attempt 的 queueMicrotask）。 */
async function dispatchOnceAsync() {
  const seen = dispatchOnce();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return seen;
}

/** 把健康状态压到「降级中且冷却已到期」：下一次请求必然成为试探。 */
function forceCooldownExpired() {
  health.succeeded(ORIGIN); // 先回 up，保证下面 failed() 的冷却从第一档重算
  health.failed({ origin: ORIGIN, code: "ECONNREFUSED" });
  assert.equal(health.snapshot.state, "down");
  assert.equal(health.snapshot.directRemainingMs, 0, "cooldownMs=0 时冷却应立即到期");
}

await test("试探请求被调用方取消：交还 probeInFlight，下个请求仍能回代理", () => {
  forceCooldownExpired();
  stub.script.proxy = [{ type: "error", code: "ABORT_ERR" }]; // 不在 PRE_DELIVERY_CODES 里
  const seen = dispatchOnce();
  assert.ok(seen.error !== null, "错误必须原样交给调用方，不能被吞");
  assert.equal(seen.error.code, "ABORT_ERR");
  assert.equal(health.snapshot.probeInFlight, false, "试探被打断后 probeInFlight 必须复位");
  assert.equal(health.snapshot.state, "down", "不因为一次取消就把代理判成好的");
  assert.equal(health.tryProxy(), true, "下一个请求应仍能被放去试代理（修复前这里是 false）");
});

await test("试探已连上、响应头之前失败（证书错）：同样交还 probeInFlight", () => {
  forceCooldownExpired();
  stub.script.proxy = [{ type: "connect" }, { type: "error", code: "ERR_TLS_CERT_ALTNAME_INVALID" }];
  const seen = dispatchOnce();
  assert.equal(seen.connect, 1, "应先建立连接（说明这条走的是「已交付但没拿到响应头」）");
  assert.ok(seen.error !== null, "错误必须原样交给调用方");
  assert.equal(health.snapshot.probeInFlight, false, "响应头之前失败也要复位 probeInFlight");
  assert.equal(health.tryProxy(), true, "下一个请求应仍能被放去试代理");
});

await test("正常的试探失败（白名单码）不受影响：仍判失败、加倍冷却、改直连重发", async () => {
  health.succeeded(ORIGIN);
  health.failed({ origin: ORIGIN, code: "ECONNREFUSED" });
  const failuresBefore = health.snapshot.failures;
  stub.script.proxy = [{ type: "error", code: "ECONNREFUSED" }];
  stub.script.direct = [{ type: "headers" }];
  const seen = await dispatchOnceAsync();
  assert.equal(seen.headers, 1, "应改直连重发并拿到响应头");
  assert.equal(health.snapshot.failures, failuresBefore + 1, "白名单码仍应记一次失败");
  assert.equal(health.snapshot.probeInFlight, false);
  assert.equal(health.snapshot.state, "down");
});

await test("已经交付（拿到响应头）的请求不会被动到试探标记", () => {
  health.succeeded(ORIGIN);
  health.failed({ origin: ORIGIN, code: "ECONNREFUSED" });
  stub.script.proxy = [{ type: "connect" }, { type: "headers" }];
  dispatchOnce();
  assert.equal(health.snapshot.state, "up", "拿到响应头就该恢复");
  assert.equal(health.snapshot.probeInFlight, false);
  assert.equal(health.snapshot.failures, 0);
});

stub.script.proxy = [];
stub.script.direct = [];
await dispose();

console.log("");
if (failures.length === 0) {
  console.log("通过 " + passed + " 项");
  console.log("全部通过 ✅");
  process.exit(0);
}
console.log("失败 " + failures.length + " 项：");
for (const message of failures) console.log(" - " + message);
process.exit(1);
