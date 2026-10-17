/**
 * 自检（M4）：并发的 applyProxyPlan / disposeProxyPlan 不能漏拆、不能漏关。
 *
 * 审查发现的口子：applyProxyPlan 是「先 dispose 再 install」两段异步，并发的两次都看到
 * `activeDispose === null`，于是都装、谁都不拆 —— 先装的 agent 的 keep-alive 连接池再也
 * 没人 close（连接泄漏），全局 dispatcher 最终落在哪个 agent 上也取决于谁后完成，
 * 可能出现「界面说生效、实际走上一版配置」。设置卡片每敲一下代理地址就可能触发一次 sync。
 *
 * 跑法：node test/dispatcher-race.mjs
 */
import assert from "node:assert/strict";
import { register } from "node:module";

register("./undici-hook.mjs", import.meta.url);

const undici = await import("./undici-stub.mjs");
const { applyProxyPlan, disposeProxyPlan } = await import("../lib/dispatcher.js");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error?.message ?? error}`);
  } finally {
    await disposeProxyPlan();
    undici.reset();
  }
}

const planFor = (proxyUrl) => ({ proxyUrl, decide: () => true });

await test("并发两次 applyProxyPlan 只留一个活着的 agent", async () => {
  undici.reset();
  const [first, second] = await Promise.all([
    applyProxyPlan(planFor("http://127.0.0.1:2080"), {}),
    applyProxyPlan(planFor("http://127.0.0.1:3080"), {}),
  ]);
  assert.equal(first.active, true);
  assert.equal(second.active, true);
  assert.equal(
    undici.openCount(),
    1,
    `只应有一个 agent 活着，实际 ${undici.openCount()} —— 先装的那个没人关就是泄漏`,
  );
  assert.equal(undici.instances.at(-1).closed, false, "最后装的那个应当是活着的");
  assert.equal(undici.currentDispatcher(), undici.instances.at(-1), "全局 dispatcher 必须是最后一次安装的 agent");
});

await test("apply 与 dispose 交错时最终回到直连、不留 agent", async () => {
  undici.reset();
  await Promise.all([applyProxyPlan(planFor("http://127.0.0.1:2080"), {}), disposeProxyPlan()]);
  assert.equal(undici.openCount(), 0, "最后一步是卸载，就不该还有 agent 活着");
  assert.equal(undici.currentDispatcher().name, "host-default", "卸载必须恢复宿主原来的 dispatcher");
});

await test("设置热更新连续三次：每次拆旧的，总量始终为 1", async () => {
  undici.reset();
  for (const port of [2080, 3080, 4080]) {
    const result = await applyProxyPlan(planFor(`http://127.0.0.1:${port}`), { enabled: true });
    assert.equal(result.active, true);
    assert.equal(undici.openCount(), 1, `换到 :${port} 之后仍应只有一个 agent`);
  }
  assert.equal(undici.instances.length, 3, "每次换装都该新建一个 agent");
  assert.equal(undici.instances.filter((instance) => instance.closed).length, 2, "前两个必须被关掉");
});

await test("enabled=false 与非法地址都只卸载、不安装", async () => {
  undici.reset();
  await applyProxyPlan(planFor("http://127.0.0.1:2080"), { enabled: true });
  assert.equal(undici.openCount(), 1);
  const disabled = await applyProxyPlan(planFor("http://127.0.0.1:2080"), { enabled: false });
  assert.equal(disabled.active, false);
  assert.equal(undici.openCount(), 0, "禁用时必须把已装的拆掉");
  const broken = await applyProxyPlan(planFor("socks5://127.0.0.1:1080"), {});
  assert.equal(broken.active, false);
  assert.equal(undici.instances.length, 1, "非法地址不该装出第二个 agent");
});

await test("M5 安装失败必须如实回报 inactive（不能报 active 却已直连）", async () => {
  undici.reset();
  undici.failures.agent = true;
  const result = await applyProxyPlan(planFor("http://127.0.0.1:2080"), {});
  assert.equal(result.active, false, "装不上还报 active，界面就会显示已生效而实际直连");
  assert.match(result.reason, /安装全局代理失败/);
  assert.equal(undici.currentDispatcher().name, "host-default", "失败后应留在宿主原 dispatcher 上");
  assert.equal(undici.openCount(), 0);
  const again = await applyProxyPlan(planFor("http://127.0.0.1:2080"), {});
  assert.equal(again.active, true, "一次失败不能把后续换装卡死（排队链不能被 rejection 毒住）");
});

await test("M5 setGlobalDispatcher 抛错时要顺手关掉已建好的 agent", async () => {
  undici.reset();
  undici.failures.setGlobal = true;
  const result = await applyProxyPlan(planFor("http://127.0.0.1:2080"), {});
  assert.equal(result.active, false);
  assert.match(result.reason, /安装全局代理失败/);
  assert.equal(undici.instances.length, 1, "agent 已经建出来了");
  assert.equal(undici.openCount(), 0, "建好了又没装上，必须 close 掉，否则连接池泄漏");
});

// L5：全局 dispatcher 是所有插件共用的单例。卸载时无脑 setGlobalDispatcher(previous)
// 会把别的插件后来装的 dispatcher 一起顶掉。
await test("L5 卸载不能覆盖别的插件后来装的 dispatcher", async () => {
  undici.reset();
  await applyProxyPlan(planFor("http://127.0.0.1:2080"), {});
  undici.setGlobalDispatcher({ name: "other-plugin" });
  await disposeProxyPlan();
  assert.equal(
    undici.currentDispatcher().name,
    "other-plugin",
    "别的插件装的 dispatcher 不能被我们卸载时顶掉",
  );
  assert.equal(undici.openCount(), 0, "我们自己的 agent 仍要关掉");
});

// L5：agent.close() 是优雅关闭，keep-alive 挂着不通的代理时会一直等 —— 卸载、热更新、
// 关 DSH 全被拖住。设上限后 destroy 收场。
await test("L5 close 卡住时按超时 destroy 收场，不拖住卸载", async () => {
  undici.reset();
  await applyProxyPlan(planFor("http://127.0.0.1:2080"), {});
  undici.setHangClose(true);
  const startedAt = Date.now();
  await disposeProxyPlan();
  const elapsed = Date.now() - startedAt;
  undici.setHangClose(false);
  const agent = undici.instances.at(-1);
  assert.equal(agent.destroyed, true, "优雅关闭卡住时必须 destroy 兜底");
  assert.equal(agent.closed, true, "destroy 后同样算已关闭");
  assert.ok(elapsed < 4000, `卸载不该被拖住，实际 ${elapsed}ms`);
});

for (const line of failures) console.error(`FAIL ${line}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
