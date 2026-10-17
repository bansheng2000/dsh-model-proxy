/**
 * 自检：设置桥的写入防线（lib/bridge.js 的 guard）。
 *
 * 直接拿路由表当 HTTP handler 跑，用假的 req/res —— 不需要真的起 DSH、不需要重启。
 * 覆盖 2026-10-17 审查实测到的口子：
 *   跨站 Origin 能写（CSRF）、text/plain 简单请求能写、未知配置字段报 ok=true 却不生效；
 *   以及「走不到回调就得证明 settings 一次都没被调用」（"返回 403" 与 "真的没写进去" 是两件事）。
 *
 * 残余风险（本测试显式记录，防回归时被误当成已修）：
 *   这四条都不是**鉴权** —— 本机任意进程都能伪造 Host/Origin/Content-Type 头。
 *   它挡的是浏览器与隧道：跨站 CSRF、DNS rebinding、cloudflared 公网入口。
 *   真鉴权要迁到宿主鉴权面 ctx.connection.fetch.register（见 README「已知限制」）。
 *
 * 侧效（同 README）：经隧道（https://<随机名>.dsh-market.com）打开 GUI 时，
 * 本插件卡片会被 403 挡下 —— 刻意取舍，隧道公网可达而这块路由能改代理出口。
 *
 * 跑法：node test/bridge-guard.mjs
 */
import assert from "node:assert/strict";

import { BRIDGE_PREFIX, inspectRequest, isJsonRequest, makeBridgeRoutes } from "../lib/bridge.js";

const NS = "model-proxy";

// ── 桩：记录 settings.mutate 到底有没有被调用 ────────────────────────────────
const calls = { mutate: 0, ops: [] };
const settings = {
  describe: () => [],
  mutate: async (ns, ops, revision) => {
    calls.mutate += 1;
    calls.ops.push({ ns, ops, revision });
  },
};
const routes = makeBridgeRoutes({
  settings,
  ns: NS,
  getStatus: async () => ({ active: false, mode: "off" }),
  getConfig: () => ({ enabled: false, mode: "off" }),
  listProviders: async () => [],
});
const routeOf = (suffix) => {
  const route = routes.find((candidate) => candidate.path === `${BRIDGE_PREFIX}${suffix}`);
  assert.ok(route, `缺少路由 ${suffix}`);
  return route;
};

// ── 最小 req / res ─────────────────────────────────────────────────────────
function makeReq({ method = "POST", headers = {}, remoteAddress = "127.0.0.1", body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, "utf8")];
  return {
    method,
    headers,
    socket: { remoteAddress },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: async () => (index < chunks.length ? { value: chunks[index++], done: false } : { value: undefined, done: true }),
      };
    },
  };
}

function makeRes() {
  const state = { status: 0, body: "" };
  return {
    state,
    writeHead(status) {
      state.status = status;
    },
    end(text) {
      state.body = String(text ?? "");
    },
  };
}

async function post(headers, body, { remoteAddress } = {}) {
  const res = makeRes();
  await routeOf("/mutate").handler(makeReq({ method: "POST", headers, body, remoteAddress }), res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.state.body);
  } catch {
    parsed = res.state.body;
  }
  return { status: res.state.status, body: parsed };
}

const JSON_BODY = JSON.stringify({ ns: NS, ops: [{ op: "set", path: ["rules", "enabled"], value: true }] });

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

// ── 1. 审查实测的三个口子 ──────────────────────────────────────────────────
await test("跨站 Origin + application/json → 403，且 settings 一次都没被调用", async () => {
  calls.mutate = 0;
  const r = await post(
    { "content-type": "application/json", origin: "https://evil.example", host: "127.0.0.1:19387" },
    JSON_BODY,
  );
  assert.equal(r.status, 403);
  assert.equal(calls.mutate, 0, "被拦的请求不能摸到 settings");
});

await test("text/plain 正文（浏览器简单请求，无预检）→ 415", async () => {
  calls.mutate = 0;
  // 故意用**同源**请求：这样拦下它的只能是 Content-Type 那条规则，
  // 而不是更早的同源检查（跨站 + text/plain 会先被 Origin 拦成 403，见下一条）。
  const r = await post({ "content-type": "text/plain", host: "127.0.0.1:19387" }, JSON_BODY);
  assert.equal(r.status, 415);
  assert.equal(calls.mutate, 0);
});

await test("跨站 + text/plain → 403（在 Content-Type 之前就被 Origin 拦下）", async () => {
  calls.mutate = 0;
  const r = await post(
    {
      "content-type": "text/plain",
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
      host: "127.0.0.1:19387",
    },
    JSON_BODY,
  );
  assert.equal(r.status, 403);
  assert.equal(calls.mutate, 0);
});

await test("压根不带 Content-Type → 415", async () => {
  calls.mutate = 0;
  const r = await post({ host: "127.0.0.1:19387" }, JSON_BODY);
  assert.equal(r.status, 415);
  assert.equal(calls.mutate, 0);
});

await test("Origin: null（沙箱 iframe / file://）→ 403", async () => {
  calls.mutate = 0;
  const r = await post({ "content-type": "application/json", origin: "null", host: "127.0.0.1:19387" }, JSON_BODY);
  assert.equal(r.status, 403);
  assert.equal(calls.mutate, 0);
});

await test("非回环 remoteAddress → 403（局域网/隧道之外的直连）", async () => {
  calls.mutate = 0;
  const r = await post({ "content-type": "application/json" }, JSON_BODY, { remoteAddress: "192.168.1.5" });
  assert.equal(r.status, 403);
  assert.equal(calls.mutate, 0);
});

// ── 2. 正常路径不能被改坏 ──────────────────────────────────────────────────
await test("同源（无 Origin 头）+ application/json → 200 且写入一次", async () => {
  calls.mutate = 0;
  const r = await post({ "content-type": "application/json", host: "127.0.0.1:19387" }, JSON_BODY);
  assert.equal(r.status, 200);
  assert.equal(r.body?.ok, true);
  assert.equal(calls.mutate, 1);
});

await test("同源 Origin 显式带上 → 200（浏览器同源 fetch 也可能带）", async () => {
  calls.mutate = 0;
  const r = await post(
    { "content-type": "application/json", origin: "http://127.0.0.1:19387", host: "127.0.0.1:19387" },
    JSON_BODY,
  );
  assert.equal(r.status, 200);
  assert.equal(calls.mutate, 1);
});

await test("经隧道的主机名 → 403 host-not-loopback（刻意取舍：隧道是公网可达的）", async () => {
  calls.mutate = 0;
  const r = await post(
    {
      "content-type": "application/json",
      origin: "https://abc123.dsh-market.com",
      host: "abc123.dsh-market.com",
    },
    JSON_BODY,
  );
  assert.equal(r.status, 403);
  assert.equal(r.body?.code, "host-not-loopback");
  assert.equal(calls.mutate, 0, "隧道来的写请求不能摸到 settings");
});

await test("Content-Type 带 charset 仍算 JSON", async () => {
  calls.mutate = 0;
  const r = await post({ "content-type": "application/json; charset=utf-8", host: "127.0.0.1:19387" }, JSON_BODY);
  assert.equal(r.status, 200);
  assert.equal(calls.mutate, 1);
});

await test("GET 路由要求对应方法（跨站 GET describe 也被 Origin 拦住）", async () => {
  const res = makeRes();
  await routeOf("/describe").handler(
    makeReq({ method: "GET", headers: { origin: "https://evil.example", host: "127.0.0.1:19387" } }),
    res,
  );
  assert.equal(res.state.status, 403);
});

// ── 3. 纯函数边界 ─────────────────────────────────────────────────────────
await test("isJsonRequest 只认 application/json 系", async () => {
  assert.equal(isJsonRequest({ headers: { "content-type": "application/json" } }), true);
  assert.equal(isJsonRequest({ headers: { "content-type": "APPLICATION/JSON" } }), true);
  assert.equal(isJsonRequest({ headers: { "content-type": "application/json;charset=utf-8" } }), true);
  assert.equal(isJsonRequest({ headers: { "content-type": "text/plain" } }), false);
  assert.equal(isJsonRequest({ headers: { "content-type": "application/x-www-form-urlencoded" } }), false);
  assert.equal(isJsonRequest({ headers: {} }), false);
  assert.equal(isJsonRequest({}), false);
});

await test("inspectRequest：Host 回环是硬门槛，Origin 有值时还须回环且与 Host 对齐", async () => {
  const verdictOf = (headers, method = "POST") =>
    inspectRequest({ socket: { remoteAddress: "127.0.0.1" }, method, headers: { "content-type": "application/json", ...headers } });
  const allow = (headers) => assert.equal(verdictOf(headers).ok, true, JSON.stringify(headers));
  const deny = (headers, code) => {
    const verdict = verdictOf(headers);
    assert.equal(verdict.ok, false, JSON.stringify(headers));
    assert.equal(verdict.code, code, JSON.stringify(headers));
  };
  // 端口 / IPv6 方括号 / 大小写归一
  allow({ host: "127.0.0.1:19387" });
  allow({ origin: "http://127.0.0.1:19387", host: "127.0.0.1:19387" });
  allow({ origin: "HTTP://127.0.0.1:19387", host: "127.0.0.1:19387" });
  allow({ origin: "http://[::1]:19387", host: "[::1]:19387" });
  allow({ origin: "https://127.0.0.1", host: "127.0.0.1" });
  allow({ origin: "http://localhost:19387", host: "localhost:19387" });
  allow({ origin: "http://localhost:80", host: "localhost" });
  // Host 非回环：挡隧道，也挡 DNS rebinding（反弹后浏览器发的 Host 仍是攻击者域名）
  deny({ host: "evil.example:19387" }, "host-not-loopback");
  deny({ host: "abc123.dsh-market.com" }, "host-not-loopback");
  deny({ host: "" }, "host-not-loopback");
  // Origin 与 Host 对不上 / Origin 非回环 / Origin 不可解析
  deny({ origin: "https://evil.example", host: "127.0.0.1:19387" }, "origin-not-trusted");
  deny({ origin: "http://localhost:19387", host: "127.0.0.1:19387" }, "origin-not-trusted");
  deny({ origin: "http://127.0.0.1:19388", host: "127.0.0.1:19387" }, "origin-not-trusted");
  deny({ origin: "null", host: "127.0.0.1:19387" }, "origin-not-trusted");
});

await test("inspectRequest：GET/HEAD 不要求 Content-Type，其余方法要 application/json", async () => {
  const get = (headers) => inspectRequest({ socket: { remoteAddress: "127.0.0.1" }, method: "GET", headers });
  assert.equal(get({ host: "127.0.0.1:19387" }).ok, true);
  assert.equal(get({ host: "127.0.0.1:19387", "content-type": "text/plain" }).ok, true);
  const post = inspectRequest({ socket: { remoteAddress: "127.0.0.1" }, method: "POST", headers: { host: "127.0.0.1:19387" } });
  assert.equal(post.ok, false);
  assert.equal(post.code, "content-type-not-json");
  assert.equal(post.status, 415);
});

await test("伪造 Host 一律 403（挡隧道 / DNS rebinding）", async () => {
  // 隧道把公网请求以 127.0.0.1 送达，所以 socket 地址不足为凭，Host 头才是指纹。
  calls.mutate = 0;
  const r = await post({ "content-type": "application/json", host: "evil.example:19387" }, JSON_BODY);
  assert.equal(r.status, 403);
  assert.equal(r.body?.code, "host-not-loopback");
  assert.equal(calls.mutate, 0);
});

// ── 4. mutate 的 op 白名单与取值校验（M6） ────────────────────────────────
// 宿主对 schema 里不存在的字段是**静默丢弃**的：op 报 ok=true、配置里却没有这个键
// （审查实测 `["rules","bogusKey"]` 就是这个结果）。这一段守住两件事：
// 非法 op 当场拒绝、且一次都不许摸到 settings。
const MUT = (ops, extra = {}) => JSON.stringify({ ns: NS, ops, ...extra });
const postOps = (body) => post({ "content-type": "application/json", host: "127.0.0.1:19387" }, body);

await test("未知字段 rules.bogusKey → 拒绝，且没有写进去", async () => {
  calls.mutate = 0;
  const r = await postOps(MUT([{ op: "set", path: ["rules", "bogusKey"], value: true }]));
  assert.equal(r.body?.ok, false);
  assert.equal(r.body?.code, "settings-rejected");
  assert.equal(calls.mutate, 0);
});

await test("path 形态非法（太短 / 太深 / 不在 rules 下 / 不是数组）→ 全部拒绝", async () => {
  for (const path of [["bogus"], ["rules", "enabled", "deeper"], ["other", "enabled"], [], "rules"]) {
    calls.mutate = 0;
    const r = await postOps(MUT([{ op: "set", path, value: true }]));
    assert.equal(r.body?.ok, false, `path=${JSON.stringify(path)} 应被拒`);
    assert.equal(calls.mutate, 0);
  }
});

await test("op 只支持 set", async () => {
  calls.mutate = 0;
  const r = await postOps(MUT([{ op: "remove", path: ["rules", "enabled"] }]));
  assert.equal(r.body?.ok, false);
  assert.equal(calls.mutate, 0);
});

await test("取值类型不符 → 拒绝（enabled / mode / proxyUrl / selected / bypass）", async () => {
  const bad = [
    ["enabled", "yes"],
    ["enabled", 1],
    ["mode", "whatever"],
    ["mode", 3],
    ["proxyUrl", 123],
    ["selected", "api.example.com"],
    ["selected", [1]],
    ["bypass", {}],
  ];
  for (const [field, value] of bad) {
    calls.mutate = 0;
    const r = await postOps(MUT([{ op: "set", path: ["rules", field], value }]));
    assert.equal(r.body?.ok, false, `${field}=${JSON.stringify(value)} 应被拒`);
    assert.equal(calls.mutate, 0);
  }
});

await test("长度封顶：条数 200 / 单条 253 / proxyUrl 2048，超一点就拒", async () => {
  const cases = [
    ["selected", Array.from({ length: 201 }, (_, i) => `h${i}.example.com`)],
    ["selected", ["a".repeat(254)]],
    ["proxyUrl", `http://127.0.0.1:2080/${"a".repeat(2048)}`],
  ];
  for (const [field, value] of cases) {
    calls.mutate = 0;
    const r = await postOps(MUT([{ op: "set", path: ["rules", field], value }]));
    assert.equal(r.body?.ok, false, `${field} 超限应被拒`);
    assert.equal(calls.mutate, 0);
  }
});

await test("一次请求里混一条非法 op → 整单拒绝（不能只写一半）", async () => {
  calls.mutate = 0;
  const r = await postOps(
    MUT([
      { op: "set", path: ["rules", "enabled"], value: true },
      { op: "set", path: ["rules", "bogusKey"], value: 1 },
    ]),
  );
  assert.equal(r.body?.ok, false);
  assert.equal(calls.mutate, 0, "校验必须发生在写入之前");
});

await test("合法 op 照旧通过（边界值也是边界内：恰好 200 条 / 恰好 253 字符）", async () => {
  const atCapItems = Array.from({ length: 200 }, (_, i) => `h${i}.example.com`);
  calls.mutate = 0;
  const r1 = await postOps(MUT([{ op: "set", path: ["rules", "selected"], value: atCapItems }]));
  assert.equal(r1.body?.ok, true, `恰好 200 条应放行：${r1.body?.message ?? ""}`);
  const r2 = await postOps(MUT([{ op: "set", path: ["rules", "bypass"], value: ["b".repeat(253)] }]));
  assert.equal(r2.body?.ok, true, `恰好 253 字符应放行：${r2.body?.message ?? ""}`);
  assert.equal(calls.mutate, 2);
});

for (const line of failures) console.error(`FAIL ${line}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
