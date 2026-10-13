/**
 * 自检：设置卡片里域名输入的校验与拆分（lib/client.js 的那两个纯函数）。
 *
 * client.js 是浏览器 bundle，靠 window.__ModuleLoader__ 载入。这里注入一个假的
 * loader 把它抓下来，再用最小 require 桩跑 factory —— 只测纯函数，不碰 React。
 *
 * 用 DSH 自带 Node 运行：node test/client-domains.mjs
 */
import assert from "node:assert/strict";

const registrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration);
    },
  },
};

await import("../lib/client.js");
assert.equal(registrations.length, 1, "client.js 应注册一个模块");

const noop = () => {};
const client = registrations[0].factory((specifier) => {
  if (specifier === "react") {
    return { useCallback: noop, useEffect: noop, useMemo: noop, useState: noop };
  }
  if (specifier === "react/jsx-runtime") return { jsx: () => null };
  throw new Error(`unexpected require: ${specifier}`);
});
const { splitDomainInput, parseDomainEntry } = client;

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

test("splitDomainInput 按空格/逗号/分号拆开，端口不被拆坏", () => {
  assert.deepEqual(splitDomainInput("a.com b.com"), ["a.com", "b.com"]);
  assert.deepEqual(splitDomainInput("a.com,b.com;c.com"), ["a.com", "b.com", "c.com"]);
  assert.deepEqual(splitDomainInput("a.com\nb.com\r\nc.com"), ["a.com", "b.com", "c.com"]);
  assert.deepEqual(splitDomainInput("  a.com   b.com  "), ["a.com", "b.com"]);
  assert.deepEqual(splitDomainInput("api.example.com:443"), ["api.example.com:443"]);
  assert.deepEqual(splitDomainInput("   "), []);
  assert.deepEqual(splitDomainInput(""), []);
});

test("parseDomainEntry 接受 policy.js 认得的 host 模式", () => {
  for (const ok of [
    "api.example.com",
    ".example.com",
    "*.example.com",
    "api.example.com:443",
    "api.example.com:*",
    "api.example.com:any",
    "127.0.0.1",
    "localhost",
    "*",
    "[::1]",
    "API.Example.COM",
  ]) {
    assert.notEqual(parseDomainEntry(ok), null, `应接受：${ok}`);
  }
  // 归一化成小写（policy.js hostMatches 也按小写比较）
  assert.equal(parseDomainEntry("API.Example.COM"), "api.example.com");
  assert.equal(parseDomainEntry("  .Example.com  "), ".example.com");
});

test("parseDomainEntry 拒绝 scheme / 路径 / 账号 / 坏端口 / 单标签", () => {
  for (const bad of [
    "http://api.example.com",
    "https://api.example.com/v1",
    "user:pass@api.example.com",
    "api.example.com:0",
    "api.example.com:70000",
    "api example.com",
    "api.example.com\\evil",
    "localhosting",
    "bad_host.example.com",
    "-bad.example.com",
    "",
    "   ",
  ]) {
    assert.equal(parseDomainEntry(bad), null, `应拒绝：${bad}`);
  }
});

test("去重与追加按 parseDomainEntry 的归一结果比较", () => {
  const listed = new Set([parseDomainEntry("api.example.com")]);
  assert.equal(listed.has(parseDomainEntry("API.example.com")), true, "大小写不同应算同一条");
  assert.equal(listed.has(parseDomainEntry("api.example.com:443")), false, "端口不同是另一条");
});

for (const line of failures) console.error(`FAIL ${line}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;