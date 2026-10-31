import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createCoreProcess, resolveBinary } from "../lib/core-manager.js";

// 三个都实测踩过的坑：
// 1) 启动时 initial sync 与 settings 的 document-updated 会同时叫 start → 两个内核抢端口，
//    第一个被 killStrays 当野进程杀掉 → 「内核启动即退出（code=-1）」
// 2) 只 void coreStop() 的 dispose 来不及杀子进程 → 留下占端口的孤儿，下次启动直接失败
// 3) 野内核在场时 start 必须先收掉它
// 需要本机已装内核二进制；没装就跳过（这里不下载）。

const managed = path.join(os.homedir(), ".dsh", "dsh-model-proxy-core", "sing-box.exe");
if (!fs.existsSync(managed)) {
  console.log("跳过：本机没有 sing-box（" + managed + "），core-race 需要真实内核");
  process.exit(0);
}

const dir = path.join(os.tmpdir() ?? "C:/Users/12576/AppData/Local/Temp", "dsh-core-race-test");
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
// strayKillScript 按「可执行文件在托管目录里」判定野进程，所以拷一份进去
const binPath = path.join(dir, "sing-box.exe");
fs.copyFileSync(managed, binPath);
const config = {
  log: { level: "warn" },
  inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: 12081 }],
  outbounds: [{ type: "direct", tag: "direct" }],
  route: { final: "direct" },
  experimental: { clash_api: { external_controller: "127.0.0.1:19090" } },
};
const make = () => createCoreProcess({ dir, kind: "singbox", binPath, apiPort: 19090, mixedPort: 12081, config });
const alive = (pid) => spawnSync("tasklist", ["/FI", "PID eq " + pid, "/fo", "csv"], { encoding: "utf8" }).stdout.includes(String(pid));
const waitDead = async (pid) => {
  for (let i = 0; i < 20; i += 1) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

// 1) 并发 start 只能有一个进程
const p = make();
const [a, b] = await Promise.all([p.start(), p.start()]);
assert.equal(a.ok, true, "第一次 start 应成功：" + a.error);
assert.equal(b.ok, true, "并发第二次 start 不该失败：" + b.error);
assert.equal(a.pid, b.pid, "并发两次 start 必须复用同一个启动，不能各起一个内核");

// 2) killSync 必须真的把进程收掉（dispose 用它，不留孤儿）
p.killSync();
assert.equal(await waitDead(a.pid), true, "killSync 后进程必须消失");

// 3) 野内核占着端口时，start 先收掉它再起来
const listening = () => String(
  spawnSync("powershell", ["-NoProfile", "-Command", "Get-NetTCPConnection -LocalPort 19090 -State Listen -ErrorAction SilentlyContinue | Measure-Object | Select-Object -ExpandProperty Count"], { encoding: "utf8" }).stdout,
).trim();
for (let i = 0; i < 20 && listening() !== "0"; i += 1) await new Promise((r) => setTimeout(r, 250));
assert.equal(listening(), "0", "端口必须已经空出来，否则野内核一定起不来");
fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
const orphan = String(
  spawnSync("powershell", ["-NoProfile", "-Command",
    "Start-Process -FilePath '" + binPath + "' -ArgumentList 'run','-c','" + path.join(dir, "config.json") + "' -WindowStyle Hidden -PassThru | Select-Object -ExpandProperty Id",
  ], { encoding: "utf8" }).stdout,
).trim();
assert.equal(alive(orphan), true, "野内核应已启动，否则测试前提不成立：" + orphan);
const p2 = make();
const started = await p2.start();
assert.equal(started.ok, true, "野内核在场时 start 应成功：" + started.error);
assert.equal(await waitDead(orphan), true, "野内核必须被收掉：" + orphan);
p2.killSync();
console.log("core-race OK：并发 start 复用 / killSync 收进程 / 野内核先被杀");