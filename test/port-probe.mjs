/**
 * 自检：本地代理端口存活探测（只用于界面提示）。
 *
 * 重点守三件事：
 *  1. 只探本机/私网 —— 公网地址必须返回 null，否则这个提示就变成了端口扫描器；
 *  2. 只有 ECONNREFUSED 才敢说「没人监听」，超时/其它错误一律 unknown；
 *  3. 结果短缓存，面板连续刷新不会每次真连。
 *
 * 跑法：node test/port-probe.mjs
 */
import assert from "node:assert/strict";
import net from "node:net";

import { PORT_PROBE, checkProxyPort, probePort, proxyPortTarget, resetPortProbeCache } from "../lib/port-probe.js";

let passed = 0;
function ok(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log("PASS " + label);
    })
    .catch((error) => {
      console.log("FAIL " + label + " — " + (error && error.message ? error.message : error));
      throw error;
    });
}

// ── 目标裁决：哪些地址根本不该探 ────────────────────────────────────────────
await ok("公网 / 空 / 坏地址 / 非 http 协议 / bypass 命中：一律不探", () => {
  assert.equal(proxyPortTarget("https://api.example.com:443"), null, "公网主机绝不探");
  assert.equal(proxyPortTarget("http://8.8.8.8:80"), null, "公网 IP 绝不探");
  assert.equal(proxyPortTarget(""), null);
  assert.equal(proxyPortTarget("   "), null);
  assert.equal(proxyPortTarget("not a url"), null);
  assert.equal(proxyPortTarget("socks5://127.0.0.1:1080"), null, "非 http/https 协议直接跳过");
  assert.equal(proxyPortTarget("http://127.0.0.1:7890", { bypass: ["127.0.0.1"] }), null, "bypass 命中不探");
  assert.equal(proxyPortTarget("http://127.0.0.1:7890", { bypass: ["*"] }), null, "通配 bypass 也算命中");
});

await ok("本机与私网地址能解析出 host:port（缺端口按协议补）", () => {
  assert.deepEqual(proxyPortTarget("http://127.0.0.1:7890"), { host: "127.0.0.1", port: 7890 });
  assert.deepEqual(proxyPortTarget("http://localhost:7890"), { host: "localhost", port: 7890 });
  assert.deepEqual(proxyPortTarget("http://[::1]:7890"), { host: "::1", port: 7890 });
  assert.deepEqual(proxyPortTarget("http://192.168.1.5:8080"), { host: "192.168.1.5", port: 8080 });
  assert.deepEqual(proxyPortTarget("http://10.1.2.3:3128"), { host: "10.1.2.3", port: 3128 });
  assert.deepEqual(proxyPortTarget("http://172.20.0.9:8888"), { host: "172.20.0.9", port: 8888 });
  assert.deepEqual(proxyPortTarget("http://127.0.0.1"), { host: "127.0.0.1", port: 80 });
  assert.deepEqual(proxyPortTarget("https://127.0.0.1"), { host: "127.0.0.1", port: 443 });
});

// ── 真连：开着 → true；关掉 → false ─────────────────────────────────────────
const server = net.createServer((socket) => socket.destroy());
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

await ok("端口有人监听 → alive=true", async () => {
  resetPortProbeCache();
  assert.equal(await probePort("127.0.0.1", port), true);
  const result = await checkProxyPort(`http://127.0.0.1:${port}`);
  assert.equal(result.alive, true);
  assert.equal(result.port, port);
});

await ok("缓存命中：关掉端口后紧跟着再问，仍返回上一次结论（2s 内不重连）", async () => {
  await new Promise((resolve) => server.close(resolve));
  const cached = await checkProxyPort(`http://127.0.0.1:${port}`);
  assert.equal(cached.alive, true, "TTL 内应复用缓存，而不是每次真连");
});

await ok("缓存过期后：没人监听 → alive=false（这才是要给用户看的那条提示）", async () => {
  resetPortProbeCache();
  const result = await checkProxyPort(`http://127.0.0.1:${port}`);
  assert.equal(result.alive, false, "ECONNREFUSED 是明确结论，必须报 false");
});

await ok("私网地址连不上/超时 → alive=null（unknown，绝不当成活着）", async () => {
  resetPortProbeCache();
  const started = Date.now();
  const alive = await probePort("10.255.255.1", 7890, PORT_PROBE.timeoutMs);
  const elapsed = Date.now() - started;
  assert.equal(alive, null, "超时只能是 unknown");
  assert.ok(elapsed <= PORT_PROBE.timeoutMs + 400, `探测必须有上限（实际 ${elapsed}ms）`);
});

// ── 面板轮询：连续两次问同一端口只能真连一次 ───────────────────────────────
await ok("连续两次问同一端口只真正 connect 一次（轮询不重复付 300ms）", async () => {
  const polled = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => polled.listen(0, "127.0.0.1", resolve));
  const polledPort = polled.address().port;
  resetPortProbeCache();
  const realConnect = net.connect;
  let connects = 0;
  net.connect = (...args) => {
    connects += 1;
    return realConnect(...args);
  };
  try {
    let clock = 0;
    const now = () => clock;
    const first = await checkProxyPort(`http://127.0.0.1:${polledPort}`, { now });
    clock = 1500; // 仍在 2s TTL 内
    const second = await checkProxyPort(`http://127.0.0.1:${polledPort}`, { now });
    assert.equal(first.alive, true);
    assert.equal(second.alive, true);
    assert.equal(connects, 1, `TTL 内两次调用只该真连一次，实际 ${connects} 次`);
    clock = PORT_PROBE.ttlMs + 1;
    await checkProxyPort(`http://127.0.0.1:${polledPort}`, { now });
    assert.equal(connects, 2, "TTL 过期后才该重新连一次");
  } finally {
    net.connect = realConnect;
    await new Promise((resolve) => polled.close(resolve));
  }
});

console.log("");
console.log("通过 " + passed + " 项");
console.log("全部通过 ✅");
