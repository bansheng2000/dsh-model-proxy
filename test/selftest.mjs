/**
 * 自检：policy.js / providers.js / dispatcher.js 的纯逻辑 + 真实本地代理实跑。
 * 用 DSH 自带 Node 运行，不依赖宿主：node test/selftest.mjs
 */
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import {
  createDecider,
  hostMatches,
  isLoopbackHost,
  normalizeProxyUrl,
  normalizeTarget,
  normalizeTargets,
  splitTarget,
} from "../lib/policy.js";
import { buildCatalog, collectBaseUrls, createHostResolver, hostOf } from "../lib/providers.js";
import { planFromConfig } from "../lib/dispatcher.js";

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

// ── host 形态 ────────────────────────────────────────────────────────────────
test("isLoopbackHost 覆盖 127/8、localhost、::1、映射写法", () => {
  for (const host of ["localhost", "127.0.0.1", "127.9.9.9", "::1", "0.0.0.0", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["api.openai.com", "128.0.0.1", "example.com"]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});

test("splitTarget 只在第一个斜杠切分", () => {
  assert.deepEqual(splitTarget("anthropic"), { provider: "anthropic", model: undefined });
  assert.deepEqual(splitTarget("openrouter/qwen/qwen3"), { provider: "openrouter", model: "qwen/qwen3" });
});

test("hostMatches：精确 / 子域 / 通配 / 端口", () => {
  assert.equal(hostMatches("api.example.com", "API.example.com"), true);
  assert.equal(hostMatches(".example.com", "api.example.com"), true);
  assert.equal(hostMatches(".example.com", "example.com"), true);
  assert.equal(hostMatches("*.example.com", "a.b.example.com"), true);
  assert.equal(hostMatches("api.example.com:443", "api.example.com", "443"), true);
  assert.equal(hostMatches("api.example.com:443", "api.example.com", "80"), false);
  assert.equal(hostMatches("api.example.com:*", "api.example.com", "9999"), true);
  assert.equal(hostMatches("api*.example.com", "api2.example.com"), true);
  assert.equal(hostMatches("*", "anything.dev"), true);
  // 端口判定不得把 IPv6 字面量切坏
  assert.equal(hostMatches("[::1]", "[::1]"), true);
});

test("normalizeProxyUrl 补 scheme、拒 SOCKS", () => {
  assert.deepEqual(normalizeProxyUrl("127.0.0.1:2080"), { ok: true, url: "http://127.0.0.1:2080" });
  assert.equal(normalizeProxyUrl("socks5://127.0.0.1:1080").ok, false);
  assert.equal(normalizeProxyUrl("").ok, false);
});

test("normalizeTarget 按形态归类", () => {
  assert.deepEqual(normalizeTarget("openai", () => true), { kind: "provider", provider: "openai" });
  assert.deepEqual(normalizeTarget("openrouter/qwen/qwen3"), { kind: "model", provider: "openrouter", model: "qwen/qwen3" });
  assert.deepEqual(normalizeTarget("*.example.com"), { kind: "host", pattern: "*.example.com" });
  assert.deepEqual(normalizeTarget("api.example.com:443"), { kind: "host", pattern: "api.example.com:443" });
  assert.equal(normalizeTarget("# 注释"), null);
  assert.equal(normalizeTargets(["a", "a", ""]).length, 1);
});

// ── 决策器 ───────────────────────────────────────────────────────────────────
const hostsFor = createHostResolver({ declared: { openai: ["https://api.openai.com/v1"] } });

function deciderFor(entries, mode = "allowlist", extra = {}) {
  return planFromConfig({ mode, selected: entries, hostsForProvider: hostsFor, ...extra }).decide;
}

test("allowlist：勾选的 provider 走代理，未勾选直连", () => {
  const decide = deciderFor(["openai"]);
  assert.equal(decide("https://api.openai.com/v1/chat"), true);
  assert.equal(decide("https://api.anthropic.com/v1/messages"), false);
});

test("host 模式可直接勾选，且支持子域", () => {
  assert.equal(deciderFor(["*.example.com"])("https://a.example.com/x"), true);
  assert.equal(deciderFor(["*.example.com"])("https://example.org/x"), false);
});

test("everything：全部走代理，但 loopback 仍直连", () => {
  const decide = deciderFor([], "everything");
  assert.equal(decide("https://api.anthropic.com/v1"), true);
  assert.equal(decide("http://127.0.0.1:19387/"), false);
});

test("off / 空勾选 → 一律直连", () => {
  assert.equal(deciderFor([], "off")("https://api.openai.com/v1"), false);
  assert.equal(deciderFor([])("https://api.openai.com/v1"), false);
});

test("bypass 优先于勾选", () => {
  const decide = deciderFor(["openai"], "allowlist", { bypass: ["api.openai.com"] });
  assert.equal(decide("https://api.openai.com/v1"), false);
});

test("非 http(s) 协议不参与判定", () => {
  const decide = deciderFor(["*"], "everything");
  assert.equal(decide("ws://example.com/socket"), false);
});

// ── providers ────────────────────────────────────────────────────────────────
test("hostOf 保留端口、容忍尾斜杠", () => {
  assert.equal(hostOf("https://api.example.com/v1"), "api.example.com");
  assert.equal(hostOf("http://127.0.0.1:8045/v1"), "127.0.0.1:8045");
});

test("collectBaseUrls 挖出 baseURL 且跳过密钥字段", () => {
  const found = collectBaseUrls({
    api: "sk-should-not-appear",
    baseURL: "https://gw.example.com/v1",
    nested: { apiBase: "http://10.0.0.5:9000", token: "x" },
  });
  assert.ok(found.has("https://gw.example.com/v1"));
  assert.ok(found.has("http://10.0.0.5:9000"));
  assert.equal([...found].some((u) => u.includes("sk-should")), false);
});

test("实测 host 优先于声明，声明优先于出厂常量", () => {
  const resolve = createHostResolver({
    declared: { openai: ["https://declared.example.com/v1"] },
    observed: { openai: ["https://observed.example.com/v1"] },
  });
  const hosts = resolve("openai");
  assert.equal(hosts[0], "observed.example.com");
  assert.ok(hosts.includes("declared.example.com"));
  assert.ok(hosts.includes("api.openai.com"));
});

test("buildCatalog 汇总 provider 与显示名", () => {
  const rows = buildCatalog({
    providers: ["openai", "opencode2dsh"],
    providerConfig: { openai: { displayName: "OpenAI", baseURL: "https://api.openai.com/v1" } },
    discovered: [{ provider: "openai", models: ["gpt-5"] }],
  });
  const openai = rows.find((r) => r.provider === "openai");
  assert.equal(openai.displayName, "OpenAI");
  assert.ok(openai.models.includes("gpt-5"));
  assert.ok(openai.hosts.includes("api.openai.com"));
});

// ── 真实本地代理实跑：证明 ProxyAgent 分流真的生效 ──────────────────────────
// loopback 恒被策略 bypass，所以要验证"走代理"这条路径，必须用一个**非回环**的
// 本机地址（本机 LAN IP）。origin 绑在 LAN IP 上，代理在回环上：
//   · 勾选该 LAN IP → fetch 命中代理，origin 收不到任何请求
//   · 不勾选        → fetch 直连 origin，代理收不到任何请求
// 两向都验证，才算证明分流真的按 origin 决策，而不是"两个都通"。
const lanIp = process.env.SELFTEST_LAN_IP ?? "192.168.193.200";
const seen = { proxyHits: [], originHits: [] };

// 明文 http 目标下 ProxyAgent 转发的是绝对 URI 形式，代理直接应答一个标记即可，
// 无需实现 CONNECT 隧道；我们只关心"请求有没有到达代理"。
const proxy = http.createServer((req, res) => {
  seen.proxyHits.push(req.url);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ via: "proxy" }));
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;

const origin = http.createServer((req, res) => {
  seen.originHits.push(req.url);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ via: "direct" }));
});
let originBound = false;
try {
  await new Promise((resolve, reject) => {
    origin.once("error", reject);
    origin.listen(0, lanIp, resolve);
  });
  originBound = true;
} catch {
  console.log(`\n⚠ 跳过实跑验证：本机地址 ${lanIp} 不可绑定（可设 SELFTEST_LAN_IP 指定其他地址）。`);
}
const originUrl = originBound ? `http://${lanIp}:${origin.address().port}` : undefined;

const { applyProxyPlan, disposeProxyPlan } = await import("../lib/dispatcher.js");

if (originBound) {
  // ① 勾选该 host → 必须走代理
  const onPlan = planFromConfig({
    mode: "allowlist",
    selected: [lanIp],
    hostsForProvider: hostsFor,
    knownProvider: () => false,
    proxyUrl,
  });
  const installed = await applyProxyPlan(onPlan);
  assert.equal(installed.active, true, `安装失败：${installed.reason ?? ""}`);

  const proxied = await fetch(`${originUrl}/probe`).then((r) => r.json());
  assert.deepEqual(proxied, { via: "proxy" }, "勾选的 host 应当走代理");
  assert.equal(seen.originHits.length, 0, "走代理时 origin 不应被直连命中");
  assert.equal(seen.proxyHits.length, 1, "代理应恰好收到 1 个请求");
  passed += 1;

  // ② 不勾选 → 必须直连
  const offPlan = planFromConfig({
    mode: "allowlist",
    selected: ["203.0.113.9"],
    hostsForProvider: hostsFor,
    knownProvider: () => false,
    proxyUrl,
  });
  await applyProxyPlan(offPlan);
  const direct = await fetch(`${originUrl}/probe`).then((r) => r.json());
  assert.deepEqual(direct, { via: "direct" }, "未勾选的 host 应当直连");
  assert.equal(seen.proxyHits.length, 1, "直连时代理不应被命中");
  assert.equal(seen.originHits.length, 1, "origin 应恰好收到 1 个请求");
  passed += 1;

  // ③ 模式 off → 恢复原状，且不残留我们装的 agent
  await disposeProxyPlan();
  const afterDispose = await fetch(`${originUrl}/probe`).then((r) => r.json());
  assert.deepEqual(afterDispose, { via: "direct" }, "卸载后应恢复直连");
  assert.equal(seen.proxyHits.length, 1, "卸载后代理不应再被命中");
  passed += 1;
}

await new Promise((resolve) => {
  proxy.close(resolve);
});
origin.close();

console.log(`\n通过 ${passed} 项断言`);
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 项：`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("全部通过 ✅");
  if (originBound) {
    console.log(`\n实跑验证：代理收到 ${seen.proxyHits.length} 个请求，origin 收到 ${seen.originHits.length} 个`);
  }
}