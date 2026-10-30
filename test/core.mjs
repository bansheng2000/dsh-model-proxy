import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { assetFor, latestTag, buildConfig, binaryName, resolveBinary, corePaths, writeConfig, installCore, createCoreProcess } from "../lib/core-manager.js";

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

// 3) 找内核：配置路径优先，托管目录没有就报错（不抛）
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dmp-core-"));
  const missing = resolveBinary({ dir });
  assert.equal(missing.ok, false);
  assert.equal(missing.source, "managed");
  assert.match(missing.error, /还没有内核/);
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