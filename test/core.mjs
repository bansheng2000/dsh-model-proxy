import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assetFor, latestTag, buildConfig, buildCoreConfig, binaryName, resolveBinary, corePaths, writeConfig, installCore, createCoreProcess, strayKillScript, archiveEntryEscapes, checkArchiveEntries, runCommand } from "../lib/core-manager.js";

// 0b) 没有 tar 的机器（Windows Server / 精简 PATH）不能因此装不上内核：
//     tar 缺失 → PowerShell 做等价校验；两样都拿不到才降级，且必须如实标 unverified。
{
  const calls = [];
  const fakeRun = (command) => {
    calls.push(command);
    if (command === "tar") return Promise.resolve({ ok: false, error: "spawn tar ENOENT" });
    return Promise.resolve({ ok: true, out: "mihomo.exe\r\nREADME.md\r\n" });
  };
  const viaPs = await checkArchiveEntries("x.zip", { runCommand: fakeRun });
  assert.equal(viaPs.ok, true, "tar 缺失时也要能通过等价校验，否则内核永远装不上");
  assert.equal(viaPs.via, "powershell");
  assert.deepEqual(viaPs.entries, ["mihomo.exe", "README.md"]);
  assert.deepEqual(calls, ["tar", "powershell"], "先试 tar，失败才换 PowerShell");

  const none = await checkArchiveEntries("x.zip", { runCommand: () => Promise.resolve({ ok: false, error: "ENOENT" }) });
  assert.equal(none.ok, true, "两样都没有时降级为只做 sha256，不阻断安装");
  assert.equal(none.unverified, true, "降级必须如实标出来，不能假装查过成员");

  const evilRun = (command) => Promise.resolve(command === "tar"
    ? { ok: false, error: "ENOENT" }
    : { ok: true, out: "../evil.exe\n" });
  const evil = await checkArchiveEntries("x.zip", { runCommand: evilRun });
  assert.equal(evil.ok, false, "换了工具也得拦越界成员");
  assert.match(evil.error, /越界/);
}

// 0c) 外部命令必须有超时：没有它，一个卡住的 tar/PowerShell 能把「安装内核」挂到天荒地老
{
  const started = Date.now();
  const slow = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { timeoutMs: 400 });
  const elapsed = Date.now() - started;
  assert.equal(slow.ok, false, "超时必须判失败");
  assert.equal(slow.timedOut, true, "要标出「是超时，不是命令自身报错」");
  assert.ok(elapsed < 3000, `超时后应立即返回，实际用了 ${elapsed}ms`);
}

// 0a) 解压前的 zip-slip 守卫：越界成员一律拒（压缩包来自网络，不能假设它善良）
{
  for (const bad of ["../evil.sh", "..\\evil.exe", "/etc/passwd", "\\windows\\x.dll", "C:\\Windows\\x.dll", "a/../../b"]) {
    assert.equal(archiveEntryEscapes(bad), true, `越界成员必须拒：${bad}`);
  }
  for (const good of ["mihomo.exe", "sing-box-1.11.0-windows-amd64/sing-box.exe", "a/./b.txt", "..hidden"]) {
    assert.equal(archiveEntryEscapes(good), false, `正常成员不能误伤：${good}`);
  }
}

// 0) 收野内核的脚本只能落在托管目录里，且要忽略大小写（Windows 路径）
{
  const script = strayKillScript("C:\\Users\\x\\.dsh\\dsh-model-proxy-core");
  assert.ok(script.includes("dsh-model-proxy-core"), "必须按托管目录过滤，不能无差别杀进程");
  assert.ok(script.includes("OrdinalIgnoreCase"), "Windows 路径大小写不敏感，比较要忽略大小写");
  assert.ok(strayKillScript("C:/it's").includes("it''s"), "单引号要转义成两个，否则 PowerShell 语法崩");
}

// 1) 资产名是确定的：mihomo-<os>-<arch>-<tag>.zip，tag 缺 v 自动补
{
  const win = assetFor("v1.19.33", { platform: "win32", arch: "x64" });
  assert.equal(win.name, "mihomo-windows-amd64-v1.19.33.zip");
  assert.equal(win.url, "https://github.com/MetaCubeX/mihomo/releases/download/v1.19.33/mihomo-windows-amd64-v1.19.33.zip");
  assert.equal(assetFor("1.19.33", { platform: "linux", arch: "x64" }).name, "mihomo-linux-amd64-v1.19.33.zip");
  assert.equal(assetFor("v1.19.33", { platform: "darwin", arch: "arm64" }).name, "mihomo-darwin-arm64-v1.19.33.zip");
  assert.equal(assetFor("v1.19.33", { platform: "freebsd", arch: "x64" }), null);
  assert.equal(assetFor("", {}), null);
  assert.equal(binaryName("win32"), "mihomo.exe");
  assert.equal(binaryName("linux"), "mihomo");
}

// 1b) 版本发现走 302 Location，不碰 api.github.com
{
  const viaLocation = await latestTag(async () => ({
    headers: { get: (key) => (key.toLowerCase() === "location" ? "https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.33" : null) },
  }));
  assert.equal(viaLocation.ok, true);
  assert.equal(viaLocation.tag, "v1.19.33");
  // 没有 location 且 api 也失败 → 明确失败
  const noLocation = await latestTag(async (url) => ({ headers: { get: () => null }, ok: false, status: 403 }));
  assert.equal(noLocation.ok, false);
  assert.match(noLocation.error, /403/);
}

// 2) 配置：节点直接来自 buildCorePatch 的形状，能落成合法 mihomo yaml
{
  const proxies = [{ name: "A", type: "ss", server: "1.2.3.4", port: 443, cipher: "aes-128-gcm", password: "x" }];
  const proxyGroups = [{ name: "DSH", type: "select", proxies: ["A", "DIRECT"] }];
  const config = buildConfig({ proxies, proxyGroups, group: "DSH", mixedPort: 2081, apiPort: 9090, secret: "s3cret" });
  assert.equal(config["mixed-port"], 2081);
  assert.equal(config["external-controller"], "127.0.0.1:9090");
  assert.equal(config.secret, "s3cret");
  assert.deepEqual(config.proxies, proxies);
  assert.deepEqual(config["proxy-groups"], proxyGroups);
  assert.deepEqual(config.rules, ["MATCH,DSH"]);
  assert.equal(config.dns.enable, true);
  // 没节点也要能起来：退成 MATCH,DIRECT，且不生成空组
  const bare = buildConfig({ group: "DSH" });
  assert.deepEqual(bare.rules, ["MATCH,DIRECT"]);
  assert.deepEqual(bare["proxy-groups"], []);
  assert.equal(bare.secret, undefined);
}

// 2b) 双内核：sing-box 的资产名 / 二进制名 / 配置翻译
{
  const sb = assetFor("v1.12.0", { platform: "win32", arch: "x64", kind: "singbox" });
  assert.equal(sb.name, "sing-box-1.12.0-windows-amd64.zip");
  assert.equal(sb.url, "https://github.com/SagerNet/sing-box/releases/download/v1.12.0/sing-box-1.12.0-windows-amd64.zip");
  assert.equal(assetFor("v1.12.0", { platform: "linux", arch: "arm64", kind: "singbox" }).name, "sing-box-1.12.0-linux-arm64.tar.gz");
  assert.equal(binaryName("win32", "singbox"), "sing-box.exe");
  assert.equal(binaryName("linux", "singbox"), "sing-box");
  // 两种内核同目录共存，配置文件名不同
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmp-core-kinds-"));
  assert.equal(corePaths(dir, "mihomo").configPath, path.join(dir, "config.yaml"));
  assert.equal(corePaths(dir, "singbox").configPath, path.join(dir, "config.json"));
  assert.equal(corePaths(dir, "singbox").binaryPath, path.join(dir, fs.existsSync("/") ? "sing-box.exe" : "sing-box"));
  fs.rmSync(dir, { recursive: true, force: true });

  const proxies = [
    { name: "ss1", type: "ss", server: "1.2.3.4", port: 443, cipher: "aes-128-gcm", password: "p" },
    { name: "hy1", type: "hysteria2", server: "h", port: 443, password: "x", sni: "a.com", obfs: "salamander", "obfs-password": "q", up: 50, down: 200 },
    { name: "vl1", type: "vless", server: "v", port: 443, uuid: "u", tls: true, servername: "v.com", network: "ws", "ws-opts": { path: "/ws", headers: { Host: "v.com" } } },
    { name: "vm1", type: "vmess", server: "m", port: 443, uuid: "uu", cipher: "auto", alterId: 0 },
    { name: "tj1", type: "trojan", server: "t", port: 443, password: "tp", sni: "t.com" },
    { name: "zz", type: "wireguard", server: "w", port: 51820 },
  ];
  const built = buildCoreConfig("singbox", { proxies, group: "DSH", mixedPort: 2081, apiPort: 9090, secret: "s" });
  const config = built.config;
  // wireguard 翻不了就进 skipped，其余都进 outbounds
  assert.deepEqual(built.skipped, ["zz"]);
  const types = config.outbounds.map((item) => item.type);
  assert.deepEqual(types, ["selector", "shadowsocks", "hysteria2", "vless", "vmess", "trojan", "direct"]);
  assert.equal(config.outbounds[0].tag, "DSH");
  assert.equal(config.outbounds[0].default, "ss1");
  assert.deepEqual(config.route, { final: "DSH" });
  assert.equal(config.inbounds[0].listen_port, 2081);
  assert.equal(config.experimental.clash_api.external_controller, "127.0.0.1:9090");
  assert.equal(config.experimental.clash_api.secret, "s");
  // 逐条翻译的关键字段
  const byTag = Object.fromEntries(config.outbounds.map((item) => [item.tag, item]));
  assert.equal(byTag.hy1.obfs.type, "salamander");
  assert.equal(byTag.hy1.up_mbps, 50);
  assert.equal(byTag.vl1.tls.server_name, "v.com");
  assert.deepEqual(byTag.vl1.transport, { type: "ws", path: "/ws", headers: { Host: "v.com" } });
  assert.equal(byTag.vm1.alter_id, 0);
  assert.equal(byTag.tj1.tls.enabled, true);
  // JSON 落盘：扩展名说了算
  const jsonPath = path.join(os.tmpdir(), "dmp-singbox-" + process.pid + ".json");
  writeConfig(jsonPath, config);
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  assert.equal(parsed.outbounds.length, config.outbounds.length);
  fs.rmSync(jsonPath, { force: true });
  // 没节点时也要能起：只有一个 direct，route.final=direct
  const bare = buildCoreConfig("singbox", { group: "DSH" }).config;
  assert.deepEqual(bare.outbounds, [{ type: "direct", tag: "direct" }]);
  assert.deepEqual(bare.route, { final: "direct" });
}

// 3) 找内核：配置路径优先，托管目录没有就报错（不抛）
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmp-core-"));
  const missing = resolveBinary({ dir });
  assert.equal(missing.ok, false);
  assert.equal(missing.source, "managed");
  assert.match(missing.error, /还没有.*内核/);
  const fake = path.join(dir, "fake-mihomo");
  fs.writeFileSync(fake, "");
  assert.equal(resolveBinary({ binPath: fake }).ok, true);
  assert.equal(resolveBinary({ binPath: fake }).source, "config");
  assert.equal(resolveBinary({}).ok, false);
  const paths = corePaths(dir);
  assert.equal(paths.configPath, path.join(dir, "config.yaml"));
  fs.writeFileSync(paths.binaryPath, "");
  const managed = resolveBinary({ dir });
  assert.equal(managed.ok, true);
  assert.equal(managed.source, "managed");
  writeConfig(paths.configPath, buildConfig({ group: "DSH" }));
  assert.ok(fs.readFileSync(paths.configPath, "utf8").includes("mixed-port"));
  const core = createCoreProcess({ dir, binPath: path.join(dir, "nope.exe"), config: buildConfig({}), log: () => {} });
  const started = await core.start();
  assert.equal(started.ok, false);
  assert.equal(core.snapshot().state, "failed");
  assert.match(started.error, /找不到内核/);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4) 真下载 + 真启动（默认跳过，DMP_CORE_LIVE=1 才跑，联网 15MB）
if (process.env.DMP_CORE_LIVE === "1") {
  const dir = path.join(os.tmpdir(), "dmp-core-live");
  fs.rmSync(dir, { recursive: true, force: true });
  const installed = await installCore({ dir, version: process.env.DMP_CORE_VERSION ?? "", log: (line) => console.log("  install:", line) });
  assert.equal(installed.ok, true, installed.error);
  assert.ok(fs.existsSync(installed.path));
  const config = buildConfig({ group: "DSH", mixedPort: 2081, apiPort: 9090 });
  const core = createCoreProcess({ dir, binPath: installed.path, config, log: (line) => console.log("  core:", line) });
  const startedCore = await core.start();
  try {
    assert.equal(startedCore.ok, true, startedCore.error);
    assert.equal(core.snapshot().state, "running");
    const pinged = await core.ping();
    assert.equal(pinged.ok, true, pinged.error);
    console.log("  kernel version:", pinged.version);
  } finally {
    await core.stop();
    assert.equal(core.snapshot().running, false);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 5) 失败路径：查版本抛错 / 该平台无包 / 下载非 200
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmp-core-err-"));
  const boom = await installCore({ dir, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(boom.ok, false);
  assert.match(boom.error, /查版本失败.*ECONNREFUSED/);
  const noAsset = await installCore({ dir, version: "v1.19.33", platform: "freebsd", arch: "x64" });
  assert.equal(noAsset.ok, false);
  assert.match(noAsset.error, /没有可用的内核包/);
  const dl500 = await installCore({ dir, version: "v1.19.33", fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(dl500.ok, false);
  assert.match(dl500.error, /下载失败：HTTP 500/);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6) 桥路由：/core 四条真的挂上了，且能把后端结果原样回给前端
{
  const { makeBridgeRoutes, BRIDGE_PREFIX } = await import("../lib/bridge.js");
  const hit = [];
  const fakeReq = (method, body) => ({
    method,
    headers: { host: "127.0.0.1:61405", "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  });
  const fakeRes = () => {
    const res = { status: 0, body: "" };
    res.writeHead = (status) => { res.status = status; };
    res.end = (chunk) => { res.body = chunk; };
    return res;
  };
  const deps = {
    settings: { describe: () => [{ ns: "model-proxy", value: {} }] },
    ns: "model-proxy",
    getStatus: async () => ({ ok: true, mode: "allowlist" }),
    getConfig: () => ({}),
    listProviders: async () => [],
    core: {
      status: async () => ({ managed: true, nodes: 3, process: { running: false } }),
      install: async () => { hit.push("install"); return { ok: true, value: { version: "v1.19.33" } }; },
      start: async () => { hit.push("start"); return { ok: true }; },
      stop: async () => { hit.push("stop"); return { ok: true }; },
    },
  };
  const routes = makeBridgeRoutes(deps);
  const call = async (suffix, method, body) => {
    const route = routes.find((item) => item.path === BRIDGE_PREFIX + suffix);
    assert.ok(route, "missing route " + suffix);
    const res = fakeRes();
    await route.handler(fakeReq(method, body), res);
    return { status: res.status, payload: JSON.parse(res.body) };
  };
  const status = await call("/core", "GET");
  assert.equal(status.status, 200);
  assert.equal(status.payload.value.nodes, 3);
  for (const action of ["install", "start", "stop"]) {
    const done = await call("/core/" + action, "POST", {});
    assert.equal(done.status, 200);
    assert.equal(done.payload.ok, true);
  }
  assert.deepEqual(hit, ["install", "start", "stop"]);
  // 坏 body 拦在 400，不会把脏数据塞给后端
  const bad = await call("/core/start", "POST", undefined);
  assert.equal(bad.status, 400);
  assert.equal(bad.payload.code, "core-rejected");
  // 没接线 → 明确 core-unavailable 而不是抛
  const unwired = makeBridgeRoutes({ ...deps, core: undefined });
  const bare = fakeRes();
  await unwired.find((item) => item.path === BRIDGE_PREFIX + "/core").handler(fakeReq("GET"), bare);
  assert.equal(JSON.parse(bare.body).code, "core-unavailable");
}

console.log(process.env.DMP_CORE_LIVE === "1" ? "core: PASS（含真下载/真启动）" : "core: PASS");