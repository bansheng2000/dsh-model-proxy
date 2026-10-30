/**
 * 托管内核（B 方案）：让插件自己安装 / 启动 / 喂养一个 mihomo 内核。
 *
 * 为什么不把二进制打进包里：GPLv3 + 每个平台 ~15 MB + 版本要跟着内核生态走。
 * 改成「首次使用时下载」：下载走全局 fetch，因此和普通出站一样经过插件自己的分流
 * （墙内直连拉不动 GitHub 时，把 api.github.com / objects.githubusercontent.com 放进
 * 域名清单就会自动走代理）。
 *
 * 与 A 方案共用同一个控制面：mihomo 的 Clash 兼容 API 就是 core-adapter 说话的对象，
 * 所以节点池、测速、自动切换一行都不用改 —— B 多的只是「谁在跑内核」这一层。
 *
 * 配置格式天然复用：buildCorePatch() 产出的 proxies / proxy-groups 就是 mihomo 的原生格式。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import YAML from "yaml";

export const CORE_DEFAULTS = Object.freeze({
  mixedPort: 2081,
  apiPort: 9090,
  readyTimeoutMs: 20000,
  downloadTimeoutMs: 180000,
  outputLimit: 40,
  version: "",
});

const LATEST_URL = "https://github.com/MetaCubeX/mihomo/releases/latest";
const ASSET_HOST = "https://github.com/MetaCubeX/mihomo/releases/download";

/** Node 的 arch 名 → 发布包里的 arch 名。 */
function assetArch(arch) {
  if (arch === "x64") return "amd64";
  if (arch === "ia32") return "386";
  if (arch === "arm64") return "arm64";
  return arch;
}

export function binaryName(platform) {
  return platform === "win32" ? "mihomo.exe" : "mihomo";
}

/**
 * 发布资产名是确定的：mihomo-<os>-<arch>-<tag>.zip（tag 带 v）。
 * 不查 assets 列表，就不吃 api.github.com 的匿名限流（403）。
 *
 * @param {string} tag 形如 v1.19.33
 * @param {{platform?: string, arch?: string}} [options]
 * @returns {{name: string, url: string, arch: string}|null}
 */
export function assetFor(tag, options = {}) {
  const raw = String(tag ?? "").trim();
  if (raw === "") return null;
  const version = raw.startsWith("v") ? raw : `v${raw}`;
  const platform = options.platform ?? process.platform;
  const arch = assetArch(options.arch ?? process.arch);
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "";
  if (os === "") return null;
  const name = `mihomo-${os}-${arch}-${version}.zip`;
  return { name, url: `${ASSET_HOST}/${version}/${name}`, arch };
}

/**
 * 问 GitHub 现在最新 tag —— 走 releases/latest 的 302 Location，不碰 api。
 *
 * @param {Function} doFetch
 * @returns {Promise<{ok: boolean, tag?: string, error?: string}>}
 */
export async function latestTag(doFetch) {
  try {
    const response = await doFetch(LATEST_URL, { method: "GET", redirect: "manual" });
    const location = response?.headers?.get?.("location") ?? "";
    const matched = /\/tag\/(v[\d.]+[\w.\-]*)/.exec(location);
    if (matched !== null) return { ok: true, tag: matched[1] };
    // 某些实现不给 location，退回 api（可能撞限流，故排第二）
    const api = await doFetch("https://api.github.com/repos/MetaCubeX/mihomo/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "dsh-model-proxy" },
    });
    if (!api.ok) return { ok: false, error: `HTTP ${api.status}` };
    const body = await api.json();
    const tag = String(body?.tag_name ?? "");
    return tag === "" ? { ok: false, error: "拿不到最新版本号" } : { ok: true, tag };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 内核目录约定：dir 下放 config.yaml、mihomo(.exe)、log 由插件自己抓。 */
export function corePaths(dir) {
  return {
    dir,
    configPath: path.join(dir, "config.yaml"),
    binaryPath: path.join(dir, binaryName(process.platform)),
  };
}

/** 找内核：配置里显式给了路径就用它，否则看托管目录里有没有。 */
export function resolveBinary(options = {}) {
  const dir = options.dir ?? "";
  const binPath = (options.binPath ?? "").trim();
  if (binPath !== "") {
    const ok = fs.existsSync(binPath);
    return { ok, path: binPath, source: "config", error: ok ? undefined : `找不到内核：${binPath}` };
  }
  if (dir === "") return { ok: false, path: "", source: "none", error: "没有内核目录" };
  const candidate = corePaths(dir).binaryPath;
  const ok = fs.existsSync(candidate);
  return { ok, path: candidate, source: "managed", error: ok ? undefined : "托管目录里还没有内核，先点安装" };
}

/** 内核配置：mihomo 原生格式，节点直接来自 buildCorePatch()。 */
export function buildConfig(options = {}) {
  const nodes = options.nodes ?? [];
  const group = options.group ?? "DSH";
  const mixedPort = Number(options.mixedPort ?? CORE_DEFAULTS.mixedPort);
  const apiPort = Number(options.apiPort ?? CORE_DEFAULTS.apiPort);
  const proxies = options.proxies ?? [];
  const proxyGroups = options.proxyGroups ?? [];
  const config = {
    "mixed-port": mixedPort,
    "allow-lan": false,
    mode: "rule",
    "log-level": "warning",
    "external-controller": `127.0.0.1:${apiPort}`,
    // 内核自己要能直连 DNS 解析：国内域名走直连，避免"没节点时连名字都解析不出来"
    dns: {
      enable: true,
      "enhanced-mode": "fake-ip",
      "fake-ip-range": "198.18.0.1/16",
      nameserver: ["223.5.5.5", "119.29.29.29"],
    },
    proxies,
    "proxy-groups": proxyGroups,
    rules: [`MATCH,${group}`],
  };
  if (options.secret !== undefined && options.secret !== "") config.secret = options.secret;
  if (proxyGroups.length === 0) {
    // 没有节点时也要能跑：直接出网，别让内核因为空组起不来
    config.proxies = [];
    config["proxy-groups"] = [];
    config.rules = ["MATCH,DIRECT"];
  }
  void nodes;
  return config;
}

/** 把配置写盘（内核用 -f 指过去）。 */
export function writeConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, YAML.stringify(config), "utf8");
  return configPath;
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, error: String(error?.message ?? error) });
      return;
    }
    let err = "";
    child.stderr?.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => resolve({ ok: false, error: String(error?.message ?? error) }));
    child.on("close", (code) => resolve({ ok: code === 0, code, error: code === 0 ? undefined : err.trim() || `退出码 ${code}` }));
    void options;
  });
}

/** 解压：优先 bsdtar（Win10+ 自带，能解 zip），没有就退 PowerShell。 */
async function extractZip(zipPath, destDir) {
  const first = await runCommand("tar", ["-xf", zipPath, "-C", destDir]);
  if (first.ok) return { ok: true };
  const second = await runCommand("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
  ]);
  if (second.ok) return { ok: true };
  return { ok: false, error: `解压失败：${first.error ?? ""} ${second.error ?? ""}`.trim() };
}

/**
 * 下载并安装内核到 dir。网络走传入的 fetch（默认全局 fetch，因此受插件分流管辖）。
 *
 * @param {{dir: string, platform?: string, arch?: string, fetchImpl?: Function, log?: Function, version?: string}} options
 * @returns {Promise<{ok: boolean, path?: string, version?: string, asset?: string, error?: string}>}
 */
export async function installCore(options) {
  const dir = options.dir;
  const log = options.log ?? (() => {});
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (dir === "") return { ok: false, error: "没有内核目录" };
  fs.mkdirSync(dir, { recursive: true });

  const tag = String(options.version ?? "").trim() === "" ? await latestTag(doFetch) : { ok: true, tag: String(options.version) };
  if (!tag.ok) return { ok: false, error: `查版本失败：${tag.error ?? "未知原因"}` };

  const asset = assetFor(tag.tag, { platform: options.platform, arch: options.arch });
  if (asset === null) return { ok: false, error: `这个平台没有可用的内核包（${options.platform ?? process.platform}/${options.arch ?? process.arch}）` };
  log(`下载 ${asset.name} …`);

  const zipPath = path.join(dir, asset.name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CORE_DEFAULTS.downloadTimeoutMs);
  try {
    const response = await doFetch(asset.url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok || response.body === null) return { ok: false, error: `下载失败：HTTP ${response.status}` };
    const total = Number(response.headers.get("content-length") ?? 0);
    let seen = 0;
    let lastLog = 0;
    const source = Readable.fromWeb(response.body);
    source.on("data", (chunk) => {
      seen += chunk.length;
      const now = Date.now();
      if (now - lastLog > 1000) {
        lastLog = now;
        const pct = total > 0 ? ` ${Math.round((seen / total) * 100)}%` : "";
        log(`已下载 ${(seen / 1048576).toFixed(1)} MB${pct}`);
      }
    });
    await pipeline(source, fs.createWriteStream(zipPath));
  } catch (error) {
    return { ok: false, error: `下载失败：${controller.signal.aborted ? "超时" : String(error?.message ?? error)}` };
  } finally {
    clearTimeout(timer);
  }

  const extracted = await extractZip(zipPath, dir);
  if (!extracted.ok) return { ok: false, error: extracted.error ?? "解压失败" };

  // 解出来的文件名带平台后缀（mihomo-windows-amd64.exe），统一改名
  const wanted = binaryName(options.platform ?? process.platform);
  const files = fs.readdirSync(dir);
  const isWindows = (options.platform ?? process.platform) === "win32";
  const found = files.find((name) => name !== wanted && (isWindows ? /^mihomo.*\.exe$/i.test(name) : /^mihomo-[^.]*$/.test(name)));
  if (found !== undefined) {
    const target = path.join(dir, wanted);
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* 旧文件删不掉就让 rename 报错，下面会兜住 */
    }
    fs.renameSync(path.join(dir, found), target);
  }
  const binaryPath = path.join(dir, wanted);
  if (!fs.existsSync(binaryPath)) return { ok: false, error: "解压后没找到内核可执行文件" };
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(binaryPath, 0o755);
    } catch {
      /* 权限改不了也不致命 */
    }
  }
  try {
    fs.rmSync(zipPath, { force: true });
  } catch {
    /* 留着也无所谓 */
  }
  log(`内核就绪：${binaryPath}`);
  return { ok: true, path: binaryPath, version: tag.tag, asset: asset.name };
}

/**
 * 起一个托管内核进程。
 *
 * 只管三件事：写配置、拉起来等 API 就绪、能干净地停掉。重启策略留给调用方（index.js）。
 *
 * @param {{dir: string, binPath: string, config: object, log?: Function, apiPort?: number,
 *          mixedPort?: number, secret?: string, readyTimeoutMs?: number, fetchImpl?: Function}} options
 */
export function createCoreProcess(options) {
  const dir = options.dir;
  const binPath = options.binPath;
  const log = options.log ?? (() => {});
  const apiPort = Number(options.apiPort ?? CORE_DEFAULTS.apiPort);
  const mixedPort = Number(options.mixedPort ?? CORE_DEFAULTS.mixedPort);
  const secret = options.secret ?? "";
  const readyTimeoutMs = Number(options.readyTimeoutMs ?? CORE_DEFAULTS.readyTimeoutMs);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const output = [];
  const paths = corePaths(dir);

  let child = null;
  let state = "idle"; // idle | starting | running | stopped | failed
  let startedAt = 0;
  let version = "";
  let lastError = "";
  let stopRequested = false;

  const pushOutput = (chunk) => {
    const text = String(chunk).trim();
    if (text === "") return;
    output.push(text.slice(0, 400));
    while (output.length > CORE_DEFAULTS.outputLimit) output.shift();
  };

  const snapshot = () => ({
    state,
    running: state === "running",
    pid: child?.pid ?? null,
    startedAt,
    version,
    api: `127.0.0.1:${apiPort}`,
    mixedPort,
    binary: binPath,
    configPath: paths.configPath,
    lastError,
    output: [...output],
  });

  async function ping() {
    const headers = secret === "" ? {} : { authorization: `Bearer ${secret}` };
    try {
      const response = await doFetch(`http://127.0.0.1:${apiPort}/version`, { headers });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const body = await response.json();
      return { ok: true, version: String(body?.version ?? "") };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  async function waitReady() {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (child === null || child.exitCode !== null) {
        return { ok: false, error: `内核启动即退出：${output.slice(-3).join(" | ") || lastError || "无输出"}` };
      }
      const probe = await ping();
      if (probe.ok) {
        version = probe.version;
        return { ok: true, version };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { ok: false, error: `等了 ${readyTimeoutMs} ms 内核 API 还没就绪：${output.slice(-3).join(" | ")}` };
  }

  async function stop() {
    if (child === null) {
      state = "stopped";
      return { ok: true };
    }
    const target = child;
    stopRequested = true;
    const exited = new Promise((resolve) => target.once("exit", () => resolve(true)));
    try {
      if (process.platform === "win32") {
        // 走 taskkill 才能连子进程一起收掉
        spawn("taskkill", ["/pid", String(target.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        target.kill("SIGTERM");
      }
    } catch {
      /* 已经退出了 */
    }
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 5000));
    const ended = await Promise.race([exited, timeout]);
    if (!ended) {
      try {
        target.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    child = null;
    state = "stopped";
    return { ok: true };
  }

  async function start(configOverride) {
    if (state === "running") return { ok: true, ...snapshot() };
    if (!fs.existsSync(binPath)) {
      state = "failed";
      lastError = `找不到内核：${binPath}`;
      return { ok: false, error: lastError };
    }
    state = "starting";
    lastError = "";
    output.length = 0;
    stopRequested = false;
    try {
      writeConfig(paths.configPath, configOverride ?? options.config);
    } catch (error) {
      state = "failed";
      lastError = `写配置失败：${String(error?.message ?? error)}`;
      return { ok: false, error: lastError };
    }
    try {
      child = spawn(binPath, ["-d", dir, "-f", paths.configPath], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      state = "failed";
      lastError = `内核启动失败：${String(error?.message ?? error)}`;
      return { ok: false, error: lastError };
    }
    child.stdout?.on("data", pushOutput);
    child.stderr?.on("data", pushOutput);
    child.on("error", (error) => {
      lastError = String(error?.message ?? error);
      state = "failed";
    });
    child.on("exit", (code, signal) => {
      const unexpected = !stopRequested;
      child = null;
      if (state !== "failed") state = "stopped";
      if (unexpected) {
        lastError = `内核意外退出（code=${code ?? "null"} signal=${signal ?? "null"}）`;
        log(`model-proxy: ${lastError}`);
      }
    });
    const ready = await waitReady();
    if (!ready.ok) {
      state = "failed";
      lastError = ready.error ?? "内核没起来";
      await stop();
      return { ok: false, error: lastError };
    }
    state = "running";
    startedAt = Date.now();
    log(`托管内核已启动（${version}，api 127.0.0.1:${apiPort}，mixed ${mixedPort}）`);
    return { ok: true, ...snapshot() };
  }

  return { start, stop, snapshot, ping, paths };
}