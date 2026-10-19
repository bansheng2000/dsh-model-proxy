/**
 * 自检：代理「连不上且不立即失败」时的超时降级（连接超时，而不是端口拒绝）。
 * 指向 TEST-NET-1 192.0.2.1（永远不可路由），连接会卡住到 connect 超时。
 * node test/failover-timeout.mjs
 *
 * 注意边界：本用例走的是「连接没建立」这条路（https 目标经代理即此形态）。
 * 若目标是明文 http，undici 的 ProxyAgent 在**连到代理**那一刻就回调 onConnect，
 * 此时隧道是否真通无法区分，见 README「已知边界」。
 */
import assert from "node:assert/strict";
import http from "node:http";

import { fetch as undiciFetch } from "undici";

import { FAILOVER, createProxyHealth, installProxyDispatcher } from "../lib/dispatcher.js";

const events = [];
const health = createProxyHealth({ cooldownMs: 60000, onEvent: (e) => events.push(e) });

const origin = http.createServer((req, res) => res.end("origin-ok"));
await new Promise((resolve) => origin.listen(0, "127.0.0.1", resolve));
const port = origin.address().port;

const dispose = await installProxyDispatcher({
  proxyUrl: "http://192.0.2.1:2080",
  decide: () => true,
  health,
});

const started = Date.now();
const response = await undiciFetch("http://127.0.0.1:" + port + "/unreachable-proxy");
const body = await response.text();
const elapsed = Date.now() - started;

assert.equal(response.status, 200);
assert.equal(body, "origin-ok");
const snapshot = health.snapshot;
assert.equal(snapshot.state, "down", "状态应为 down");
assert.equal(snapshot.retries, 1, "应恰好重试一次");
assert.ok(elapsed < FAILOVER.attemptTimeoutMs + 5000, "应在超时阈值内改直连，实际 " + elapsed + "ms");
assert.ok(events.some((e) => e.type === "proxy-failed"), "应有 proxy-failed 事件");
assert.ok(events.some((e) => e.type === "fallback"), "应有 fallback 事件");

await dispose();
origin.close();
console.log("PASS 不可路由代理：约 " + elapsed + "ms 后改直连成功，lastError=" + snapshot.lastError);
console.log("全部通过 ✅");
process.exit(0);
