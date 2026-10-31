/**
 * 托管内核：让插件自己安装 / 启动 / 喂养一个本机内核。
 *
 * 支持两种内核，装在同一目录里可以共存，用 `coreKind` 选跑哪个：
 *   mihomo  —— Clash 兼容，配置 YAML，控制面 /version /proxies（就是 core-adapter 说话的对象）
 *   sing-box—— 官方内核，配置 JSON，同样带 Clash 兼容 API（experimental.clash_api）
 * 两者控制面一致，所以节点池、测速、自动切换对内核是哪一种完全无感。
 *
 * 为什么不把二进制打进包里：GPLv3 + 每个平台 ~15 MB + 版本要跟着内核生态走。
 * 改成「首次使用时下载」：下载走全局 fetch，因此和普通出站一样经过插件自己的分流
 * （墙内直连拉不动 GitHub 时，把 github.com / objects.githubusercontent.com 放进
 * 域名清单就会自动走代理）。
 */
import { spawn, spawnSync } from "node:child_process";
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

/** 可选内核。默认 mihomo（生态更全：节点字段原样透传，不用二次翻译）。 */
export const CORE_KINDS = Object.freeze(["mihomo", "singbox"]);

/**
 * 收掉托管目录里残留的内核进程的 PowerShell 脚本。
 *
 * 为什么需要：DSH 被强杀/崩溃时插件来不及 stop，旧内核留在后台占着 mixed/api 端口。
 * 下一次启动或换内核时，新进程绑不上端口 → 立刻退出，界面只会看到
 * 「内核意外退出（code=1 signal=null）」，而真正占着端口的正是那个孤儿进程。
 * 只收「可执行文件就在托管目录里」的进程，不碰用户自己的代理软件。
 */
export function strayKillScript(dir) {
  const escaped = String(dir).replace(/'/g, "''");
  // 分隔符统一成反斜杠再比：ExecutablePath 永远是 C:\...\，配置里可能是 C:/...
  return `$needle = '${escaped}'.Replace('/','\\').ToLowerInvariant(); Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Replace('/','\\').ToLowerInvariant().StartsWith($needle, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
}

/** 同步收掉野进程；收不掉也不许挡住启动。 */
function killStrays(dir) {
  try {
    if (process.platform === "win32") {
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", strayKillScript(dir)], { windowsHide: true, stdio: "ignore" });
    } else {
      spawnSync("pkill", ["-f", dir], { stdio: "ignore" });
    }
  } catch {
    /* 没有 powershell / pkill 就算了 */
  }
}

const KINDS = {
  mihomo: {
    repo: "MetaCubeX/mihomo",
    binary: "mihomo",
    config: "config.yaml",
    // 解压出来的文件名带平台后缀（mihomo-windows-amd64.exe），按这个找
    find: /^mihomo[-.].*\.exe$/i,
    args: (dir, configPath) => ["-d", dir, "-f", configPath],
  },
  singbox: {
    repo: "SagerNet/sing-box",
    binary: "sing-box",
    config: "config.json",
    find: /^sing-box[-.].*\.exe$/i,
    args: (_dir, configPath) => ["run", "-c", configPath],
  },
};

/** 认不出来的一律当 mihomo（老配置里没有这个字段）。 */
export function normalizeKind(kind) {
  const raw = String(kind ?? "").trim().toLowerCase();
  return raw === "singbox" || raw === "sing-box" ? "singbox" : "mihomo";
}

const kindInfo = (kind) => KINDS[normalizeKind(kind)];

/** Node 的 arch 名 → 发布包里的 arch 名。 */
function assetArch(arch) {
  if (arch === "x64") return "amd64";
  if (arch === "ia32") return "386";
  if (arch === "arm64") return "arm64";
  return arch;
}

function osName(platform) {
  return platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : platform === "linux" ? "linux" : "";
}

export function binaryName(platform, kind = "mihomo") {
  return platform === "win32" ? `${kindInfo(kind).binary}.exe` : kindInfo(kind).binary;
}

/**
 * 发布资产名是确定的，不查 assets 列表 —— 就不吃 api.github.com 的匿名限流（403）。
 *
 *   mihomo  : mihomo-<os>-<arch>-<tag>.zip        （tag 带 v）
 *   sing-box: sing-box-<ver>-<os>-<arch>.zip      （win 是 zip，其他平台 tar.gz；
 *             版本号不带 v）
 *
 * @param {string} tag 形如 v1.19.33
 * @param {{platform?: string, arch?: string, kind?: string}} [options]
 * @returns {{name: string, url: string, arch: string, kind: string}|null}
 */
export function assetFor(tag, options = {}) {
  const raw = String(tag ?? "").trim();
  if (raw === "") return null;
  const kind = normalizeKind(options.kind);
  const version = raw.startsWith("v") ? raw : `v${raw}`;
  const platform = options.platform ?? process.platform;
  const arch = assetArch(options.arch ?? process.arch);
  const os = osName(platform);
  if (os === "") return null;
  const name = kind === "singbox"
    ? `sing-box-${version.slice(1)}-${os}-${arch}${os === "windows" ? ".zip" : ".tar.gz"}`
    : `mihomo-${os}-${arch}-${version}.zip`;
  return { name, url: `https://github.com/${kindInfo(kind).repo}/releases/download/${version}/${name}`, arch, kind };
}

/**
 * 问 GitHub 现在最新 tag —— 走 releases/latest 的 302 Location，不碰 api。
 *
 * @param {Function} doFetch
 * @param {string} [kind]
 * @returns {Promise<{ok: boolean, tag?: string, error?: string}>}
 */
export async function latestTag(doFetch, kind = "mihomo") {
  const repo = kindInfo(kind).repo;
  try {
    const response = await doFetch(`https://github.com/${repo}/releases/latest`, { method: "GET", redirect: "manual" });
    const location = response?.headers?.get?.("location") ?? "";
    const matched = /\/tag\/(v[\d.]+[\w.\-]*)/.exec(location);
    if (matched !== null) return { ok: true, tag: matched[1] };
    // 某些实现不给 location，退回 api（可能撞限流，故排第二）
    const api = await doFetch(`https://api.github.com/repos/${repo}/releases/latest`, {
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

/** 内核目录约定：dir 下放 config.<yaml|json>、<内核>(.exe)，两种内核可共存。 */
export function corePaths(dir, kind = "mihomo") {
  const info = kindInfo(kind);
  return {
    dir,
    configPath: path.join(dir, info.config),
    binaryPath: path.join(dir, binaryName(process.platform, kind)),
  };
}

/** 在目录（含一层子目录，sing-box 的包是解成子目录的）里找可执行文件。 */
function findBinaryFile(dir, kind, platform) {
  const info = kindInfo(kind);
  const isWindows = platform === "win32";
  const matches = (name) => (isWindows
    ? (info.find.test(name) || new RegExp(`^${info.binary}\\.exe$`, "i").test(name))
    : name === info.binary || name.startsWith(`${info.binary}-`) || name.startsWith(`${info.binary}_`));
  const walk = (current, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (entry.isFile() && matches(entry.name)) return path.join(current, entry.name);
    }
    if (depth <= 0) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = walk(path.join(current, entry.name), depth - 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(dir, 2);
}

/** 找内核：配置里显式给了路径就用它，否则看托管目录里有没有。 */
export function resolveBinary(options = {}) {
  const dir = options.dir ?? "";
  const kind = normalizeKind(options.kind);
  const binPath = (options.binPath ?? "").trim();
  if (binPath !== "") {
    const ok = fs.existsSync(binPath);
    return { ok, path: binPath, source: "config", kind, error: ok ? undefined : `找不到内核：${binPath}` };
  }
  if (dir === "") return { ok: false, path: "", source: "none", kind, error: "没有内核目录" };
  const candidate = corePaths(dir, kind).binaryPath;
  const ok = fs.existsSync(candidate);
  return { ok, path: candidate, source: "managed", kind, error: ok ? undefined : "托管目录里还没有这个内核，先点安装" };
}

/** 内核配置（mihomo 原生格式）：节点直接来自 buildCorePatch()。 */
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

// ── sing-box 配置：Clash 条目 → sing-box outbound ───────────────────────────
// 上游只给 mihomo 格式（订阅解析 + toMihomoProxy 的产物就是 Clash 字典），
// 这里做一层翻译。翻译不了的类型返回 null，由调用方记 skipped。

function tlsOf(proxy) {
  const reality = proxy["reality-opts"];
  const sni = String(proxy.servername ?? proxy.sni ?? "").trim() || String(proxy.server ?? "");
  const tls = { enabled: true, server_name: sni };
  if (proxy["skip-cert-verify"] === true || proxy["skip-cert-verify"] === "true") tls.insecure = true;
  if (Array.isArray(proxy.alpn) && proxy.alpn.length > 0) tls.alpn = proxy.alpn.map(String);
  if (reality !== undefined && reality !== null && typeof reality === "object") {
    tls.reality = { enabled: true, public_key: String(reality["public-key"] ?? "") };
    const shortId = String(reality["short-id"] ?? "").trim();
    if (shortId !== "") tls.reality.short_id = shortId;
    tls.utls = { enabled: true, fingerprint: String(proxy["client-fingerprint"] ?? "chrome") };
    return tls;
  }
  return tls;
}

function transportOf(proxy) {
  const network = String(proxy.network ?? "").toLowerCase();
  const ws = proxy["ws-opts"];
  if (network === "ws" || (ws !== undefined && ws !== null)) {
    const opts = ws ?? {};
    const headers = opts.headers ?? {};
    const transport = { type: "ws", path: String(opts.path ?? "/") };
    const host = headers.Host ?? headers.host;
    if (host !== undefined && String(host).trim() !== "") transport.headers = { Host: String(host) };
    return transport;
  }
  const grpc = proxy["grpc-opts"];
  if (network === "grpc" || (grpc !== undefined && grpc !== null)) {
    return { type: "grpc", service_name: String((grpc ?? {})["grpc-service-name"] ?? "") };
  }
  if (network === "http") {
    const opts = proxy["http-opts"] ?? {};
    const headers = opts.headers ?? {};
    const host = Array.isArray(headers.Host) ? headers.Host[0] : headers.Host;
    const transport = { type: "http", path: String(Array.isArray(opts.path) ? opts.path[0] : opts.path ?? "/") };
    if (host !== undefined) transport.host = [String(host)];
    return transport;
  }
  return null;
}

function outboundOf(proxy) {
  const type = String(proxy.type ?? "").toLowerCase();
  const tag = String(proxy.name ?? "");
  const base = { tag, server: String(proxy.server ?? ""), server_port: Number(proxy.port ?? 0) };
  if (type === "ss") {
    return { ...base, type: "shadowsocks", method: String(proxy.cipher ?? ""), password: String(proxy.password ?? "") };
  }
  if (type === "vmess") {
    return {
      ...base,
      type: "vmess",
      uuid: String(proxy.uuid ?? ""),
      security: String(proxy.cipher ?? "auto"),
      alter_id: Number(proxy.alterId ?? 0),
      ...(proxy.tls === true ? { tls: tlsOf(proxy) } : {}),
      ...(transportOf(proxy) === null ? {} : { transport: transportOf(proxy) }),
    };
  }
  if (type === "vless") {
    const out = { ...base, type: "vless", uuid: String(proxy.uuid ?? "") };
    const flow = String(proxy.flow ?? "").trim();
    if (flow !== "") out.flow = flow;
    // vless 只有开了 TLS（或 reality）才需要 tls 段；明文 vless 别硬塞
    if (proxy.tls === true || proxy["reality-opts"] !== undefined) out.tls = tlsOf(proxy);
    const transport = transportOf(proxy);
    if (transport !== null) out.transport = transport;
    return out;
  }
  if (type === "trojan") {
    return { ...base, type: "trojan", password: String(proxy.password ?? ""), tls: tlsOf(proxy) };
  }
  if (type === "hysteria2" || type === "hy2") {
    const out = { ...base, type: "hysteria2", password: String(proxy.password ?? proxy.auth ?? ""), tls: tlsOf(proxy) };
    const obfs = String(proxy.obfs ?? "").trim();
    if (obfs !== "" && obfs !== "none") out.obfs = { type: obfs, password: String(proxy["obfs-password"] ?? "") };
    if (Number(proxy.up ?? 0) > 0) out.up_mbps = Number(proxy.up);
    if (Number(proxy.down ?? 0) > 0) out.down_mbps = Number(proxy.down);
    return out;
  }
  if (type === "http") {
    const out = { ...base, type: "http" };
    if (proxy.username !== undefined) out.username = String(proxy.username);
    if (proxy.password !== undefined) out.password = String(proxy.password);
    return { ...out, ...(proxy.tls === true ? { tls: tlsOf(proxy) } : {}) };
  }
  if (type === "socks5") {
    const out = { ...base, type: "socks", version: "5" };
    if (proxy.username !== undefined) out.username = String(proxy.username);
    if (proxy.password !== undefined) out.password = String(proxy.password);
    return out;
  }
  if (type === "tuic") {
    return {
      ...base,
      type: "tuic",
      uuid: String(proxy.uuid ?? ""),
      password: String(proxy.password ?? ""),
      tls: tlsOf(proxy),
      ...(String(proxy["congestion-controller"] ?? "").trim() === "" ? {} : { congestion_control: String(proxy["congestion-controller"]) }),
    };
  }
  return null;
}

/**
 * 内核配置（sing-box 原生格式 JSON）。
 *
 * @param {{proxies?: object[], group?: string, mixedPort?: number, apiPort?: number,
 *          secret?: string}} options
 * @returns {{config: object, skipped: string[]}}
 */
export function buildSingboxConfig(options = {}) {
  const group = String(options.group ?? "DSH");
  const mixedPort = Number(options.mixedPort ?? CORE_DEFAULTS.mixedPort);
  const apiPort = Number(options.apiPort ?? CORE_DEFAULTS.apiPort);
  const proxies = options.proxies ?? [];
  const outbounds = [];
  const skipped = [];
  for (const proxy of proxies) {
    const converted = outboundOf(proxy);
    if (converted === null) skipped.push(String(proxy?.name ?? proxy?.type ?? "?"));
    else outbounds.push(converted);
  }
  const tags = outbounds.map((item) => item.tag);
  const clashApi = { external_controller: `127.0.0.1:${apiPort}` };
  if (options.secret !== undefined && options.secret !== "") clashApi.secret = options.secret;
  const config = {
    log: { level: "warn" },
    inbounds: [{ type: "mixed", tag: "mixed-in", listen: "127.0.0.1", listen_port: mixedPort }],
    outbounds: tags.length === 0
      ? [{ type: "direct", tag: "direct" }]
      : [{ type: "selector", tag: group, outbounds: tags, default: tags[0] }, ...outbounds, { type: "direct", tag: "direct" }],
    route: { final: tags.length === 0 ? "direct" : group },
    experimental: { clash_api: clashApi },
  };
  return { config, skipped };
}

/** 按 kind 产配置（两种格式的入口，index.js 只调这个）。 */
export function buildCoreConfig(kind, options = {}) {
  if (normalizeKind(kind) === "singbox") {
    const built = buildSingboxConfig(options);
    return { config: built.config, skipped: built.skipped };
  }
  return { config: buildConfig(options), skipped: [] };
}

/** 把配置写盘（内核用 -f/-c 指过去）。看扩展名决定 YAML 还是 JSON。 */
export function writeConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const text = path.extname(configPath).toLowerCase() === ".json"
    ? JSON.stringify(config, null, 2)
    : YAML.stringify(config);
  fs.writeFileSync(configPath, text, "utf8");
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

/** 解压：优先 bsdtar（Win10+ 自带，能解 zip 和 tar.gz），没有就退 PowerShell。 */
async function extractArchive(archivePath, destDir) {
  const first = await runCommand("tar", ["-xf", archivePath, "-C", destDir]);
  if (first.ok) return { ok: true };
  const second = await runCommand("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
  ]);
  if (second.ok) return { ok: true };
  return { ok: false, error: `解压失败：${first.error ?? ""} ${second.error ?? ""}`.trim() };
}

/**
 * 下载并安装一个内核到 dir。网络走传入的 fetch（默认全局 fetch，因此受插件分流管辖）。
 * 两种内核装同一个目录、二进制名不同，可以共存。
 *
 * @param {{dir: string, kind?: string, platform?: string, arch?: string, fetchImpl?: Function,
 *          log?: Function, version?: string}} options
 * @returns {Promise<{ok: boolean, kind?: string, path?: string, version?: string, asset?: string, error?: string}>}
 */
export async function installCore(options) {
  const dir = options.dir;
  const log = options.log ?? (() => {});
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const kind = normalizeKind(options.kind);
  const platform = options.platform ?? process.platform;
  if (dir === "") return { ok: false, kind, error: "没有内核目录" };
  fs.mkdirSync(dir, { recursive: true });

  const tag = String(options.version ?? "").trim() === "" ? await latestTag(doFetch, kind) : { ok: true, tag: String(options.version) };
  if (!tag.ok) return { ok: false, kind, error: `查版本失败：${tag.error ?? "未知原因"}` };

  const asset = assetFor(tag.tag, { platform, arch: options.arch, kind });
  if (asset === null) return { ok: false, kind, error: `这个平台没有可用的内核包（${platform}/${options.arch ?? process.arch}）` };
  log(`下载 ${asset.name} …`);

  const archivePath = path.join(dir, asset.name);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CORE_DEFAULTS.downloadTimeoutMs);
  try {
    const response = await doFetch(asset.url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok || response.body === null) return { ok: false, kind, error: `下载失败：HTTP ${response.status}` };
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
    await pipeline(source, fs.createWriteStream(archivePath));
  } catch (error) {
    return { ok: false, kind, error: `下载失败：${controller.signal.aborted ? "超时" : String(error?.message ?? error)}` };
  } finally {
    clearTimeout(timer);
  }

  const extracted = await extractArchive(archivePath, dir);
  if (!extracted.ok) return { ok: false, kind, error: extracted.error ?? "解压失败" };

  // 解出来的文件名带平台后缀，目录结构也因内核而异（sing-box 是压缩包子目录），统一改名
  const wanted = binaryName(platform, kind);
  const target = path.join(dir, wanted);
  const found = findBinaryFile(dir, kind, platform);
  if (found !== null && path.resolve(found) !== path.resolve(target)) {
    try {
      fs.rmSync(target, { force: true });
    } catch {
      /* 旧文件删不掉就让 rename 报错，下面会兜住 */
    }
    try {
      fs.renameSync(found, target);
    } catch (error) {
      return { ok: false, kind, error: `内核改名失败：${String(error?.message ?? error)}` };
    }
  }
  if (!fs.existsSync(target)) return { ok: false, kind, error: "解压后没找到内核可执行文件" };
  if (platform !== "win32") {
    try {
      fs.chmodSync(target, 0o755);
    } catch {
      /* 权限改不了也不致命 */
    }
  }
  try {
    fs.rmSync(archivePath, { force: true });
  } catch {
    /* 留着也无所谓 */
  }
  // sing-box 的包会解出一个 sing-box-<版本>-<os>-<arch>/ 子目录（可执行文件已被搬走），清掉它
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^(mihomo|sing-box)[-_]/i.test(entry.name)) continue;
    try {
      fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    } catch {
      /* 删不掉就留着，不影响启动 */
    }
  }
  log(`内核就绪：${target}`);
  return { ok: true, kind, path: target, version: tag.tag, asset: asset.name };
}

/**
 * 起一个托管内核进程（mihomo 或 sing-box）。
 *
 * 只管三件事：写配置、拉起来等 API 就绪、能干净地停掉。重启策略留给调用方（index.js）。
 *
 * @param {{dir: string, binPath: string, kind?: string, config: object, log?: Function,
 *          apiPort?: number, mixedPort?: number, secret?: string, readyTimeoutMs?: number,
 *          fetchImpl?: Function}} options
 */
export function createCoreProcess(options) {
  const dir = options.dir;
  const binPath = options.binPath;
  const log = options.log ?? (() => {});
  const kind = normalizeKind(options.kind);
  const info = kindInfo(kind);
  const apiPort = Number(options.apiPort ?? CORE_DEFAULTS.apiPort);
  const mixedPort = Number(options.mixedPort ?? CORE_DEFAULTS.mixedPort);
  const secret = options.secret ?? "";
  const readyTimeoutMs = Number(options.readyTimeoutMs ?? CORE_DEFAULTS.readyTimeoutMs);
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const output = [];
  const paths = corePaths(dir, kind);

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
    kind,
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
      // SIGKILL 之后也要等进程真的消失：不等就直接起下一个内核，端口还在旧进程手里
      const deadline = Date.now() + 2000;
      while (target.exitCode === null && target.signalCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    child = null;
    state = "stopped";
    return { ok: true };
  }

  // 启动可能被多处同时触发（启动时的 initial sync 与 settings 的 document-updated 会撞车）。
  // 不串行化的后果：第二次 start 看到 state 还是 "starting" 就再 spawn 一个，killStrays 顺手把
  // 第一个刚起的进程当野进程杀掉、第二个又抢不到端口 → 「内核启动即退出（code=-1）」。
  let startPromise = null;
  async function start(configOverride) {
    if (state === "running") return { ok: true, ...snapshot() };
    if (startPromise !== null) return startPromise;
    startPromise = doStart(configOverride).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  /** 同步收掉自己起的子进程：dispose/DSH 退出时不能只 void 一个异步 stop，本进程可能先死。 */
  function killSync() {
    const target = child;
    if (target === null) return { ok: true };
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(target.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        target.kill("SIGKILL");
      }
    } catch {
      /* 已经退出了 */
    }
    child = null;
    state = "stopped";
    return { ok: true };
  }

  async function doStart(configOverride) {
    if (!fs.existsSync(binPath)) {
      state = "failed";
      lastError = `找不到内核：${binPath}`;
      return { ok: false, error: lastError };
    }
    state = "starting";
    lastError = "";
    output.length = 0;
    stopRequested = false;
    // 先确保没有别的实例占着端口（DSH 崩溃留下的孤儿内核）
    killStrays(dir);
    try {
      writeConfig(paths.configPath, configOverride ?? options.config);
    } catch (error) {
      state = "failed";
      lastError = `写配置失败：${String(error?.message ?? error)}`;
      return { ok: false, error: lastError };
    }
    try {
      child = spawn(binPath, info.args(dir, paths.configPath), {
        cwd: dir,
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
    log(`托管内核已启动（${kind} ${version}，api 127.0.0.1:${apiPort}，mixed ${mixedPort}）`);
    return { ok: true, ...snapshot() };
  }

  return { start, stop, killSync, snapshot, ping, paths, kind };
}