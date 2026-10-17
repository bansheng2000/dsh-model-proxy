/**
 * 自检：探针目标的裁决（lib/policy.js 的 probeTargetVerdict / isPrivateHost）。
 *
 * /probe 是本机进程里的 HTTP 客户端。审查实测它能按状态码与耗时区分 127.0.0.1 上
 * 哪些端口开着（19387 → 401、2080 → 400、1 → fetch failed），所以必须收口。
 * 这几条断言守住三件事：回环被拒、内网/保留段被拒、清单外的公网域名被拒。
 *
 * 纯函数，不需要 DSH 宿主。跑法：node test/probe-guard.mjs
 */
import assert from "node:assert/strict";

import { isPrivateHost, probeTargetVerdict } from "../lib/policy.js";

const ALLOW = (url, rules) => {
  const verdict = probeTargetVerdict(new URL(url), rules);
  assert.equal(verdict.ok, true, `${url} 应放行，实际被拒：${verdict.reason}`);
};
const REJECT = (url, rules, expectFragment) => {
  const verdict = probeTargetVerdict(new URL(url), rules);
  assert.equal(verdict.ok, false, `${url} 应被拒`);
  if (expectFragment !== undefined) {
    assert.ok(
      String(verdict.reason).includes(expectFragment),
      `${url} 的拒绝理由应包含「${expectFragment}」，实际是「${verdict.reason}」`,
    );
  }
};

const RULES = { mode: "allowlist", selected: ["api.example.com", "*.example.org", "8.8.8.8"] };

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

test("回环地址一律拒（含审查实测扫过的 127.0.0.1 各端口）", () => {
  for (const url of [
    "http://127.0.0.1:19387/",
    "http://127.0.0.1:2080/",
    "http://127.0.0.1:1/",
    "http://127.9.9.9/",
    "http://localhost:19387/",
    "http://[::1]:19387/",
    "http://0.0.0.0:19387/",
  ]) {
    REJECT(url, RULES, "回环");
  }
});

test("内网 / 保留网段一律拒（含云元数据地址）", () => {
  for (const url of [
    "http://10.0.0.1/",
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:10.0.0.1]/",
  ]) {
    REJECT(url, RULES, "内网");
  }
});

test("清单里的公网域名放行", () => {
  ALLOW("https://api.example.com/v1", RULES);
  ALLOW("https://a.b.example.org/", RULES); // *.example.org
  ALLOW("https://example.org/", RULES); // 泛域名也含裸域
  ALLOW("https://8.8.8.8/", RULES);
});

test("清单外的公网域名被拒（提示先加进清单）", () => {
  REJECT("https://generativelanguage.googleapis.com/", RULES, "不在");
  REJECT("https://api.openai.com/", RULES, "不在");
});

test("everything 模式放行任意公网域名，但回环/内网仍然拒", () => {
  const everything = { mode: "everything", selected: [] };
  ALLOW("https://api.openai.com/", everything);
  REJECT("http://127.0.0.1:19387/", everything, "回环");
  REJECT("http://192.168.1.1/", everything, "内网");
});

test("端口限制：清单写了 :443，探 :80 不算命中", () => {
  const rules = { mode: "allowlist", selected: ["api.example.com:443"] };
  ALLOW("https://api.example.com/v1", rules); // 默认 443
  REJECT("http://api.example.com/v1", rules, "不在"); // 80
});

test("空主机名 / 无主机名被拒", () => {
  assert.equal(probeTargetVerdict({ hostname: "", port: "" }, RULES).ok, false);
  assert.equal(probeTargetVerdict(undefined, RULES).ok, false);
});

test("isPrivateHost 不把公网地址误判成内网", () => {
  for (const host of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "192.169.0.1", "api.example.com"]) {
    assert.equal(isPrivateHost(host), false, `${host} 不该被判为内网`);
  }
  for (const host of ["10.1.2.3", "172.16.0.1", "172.31.1.1", "192.168.0.1", "169.254.1.1", "100.64.0.1", "0.1.2.3"]) {
    assert.equal(isPrivateHost(host), true, `${host} 该被判为内网`);
  }
});

test("L3 通配模式反复判定结果稳定（正则缓存不能带残留状态）", () => {
  // `a*` 走的是「编译成正则」那条分支（[^.]* 不跨标签），也是加了缓存的那条
  const rules = { mode: "allowlist", selected: ["a*.example.com"] };
  for (let round = 0; round < 3; round += 1) {
    ALLOW("https://ab.example.com/v1", rules);
    // 连续两次命中同一个模式：缓存的正则若带 g 标志，第二次会从上次的 lastIndex 开始扫
    ALLOW("https://ac.example.com/", rules);
    REJECT("https://ab.cd.example.com/v1", rules, "不在");
    REJECT("https://zz.example.com/", rules, "不在");
  }
  // `*.` 是另一条分支：apex + 任意层子域，顺带锁住它的行为
  const deep = { mode: "allowlist", selected: ["*.example.org"] };
  ALLOW("https://example.org/", deep);
  ALLOW("https://a.b.example.org/", deep);
  REJECT("https://example.net/", deep, "不在");
});

test("L3 模式多到缓存上限后判定仍然正确（满了整体丢弃重来）", () => {
  const patterns = [];
  for (let i = 0; i < 600; i += 1) patterns.push(`*.d${i}.example.com`);
  const rules = { mode: "allowlist", selected: patterns };
  // 一条都不命中 → 600 个模式全被编译，途中会撞到上限并整体清空
  REJECT("https://a.nomatch.example.com/", rules, "不在");
  ALLOW("https://a.d0.example.com/", rules);
  ALLOW("https://host.d599.example.com/", rules);
  REJECT("https://a.nomatch.example.com/", rules, "不在");
});

for (const line of failures) console.error(`FAIL ${line}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
