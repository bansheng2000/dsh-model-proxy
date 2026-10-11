/**
 * dsh-model-proxy — 路由策略（纯函数，可独立测试）
 *
 * 这一层只回答一个问题：**这个出站 URL 该不该走本地代理？**
 * 它不认识 undici、不认识 ctx，因此可以在没有 DSH 宿主的普通 Node 进程里单测。
 *
 * 设计要点：
 * - 未勾选 = 直连，这是需求里明确的方向（m00141）。所以默认模式是 allowlist（白名单），
 *   插件默认关闭（enabled=false），首次装上不会改变任何现有出站行为。
 * - 勾选的粒度是「供应商 / 模型 / 主机」，但真正生效的粒度是**主机**：undici 的 Agent
 *   factory 只看得到 origin，看不到是哪个 provider 发出来的。所以 provider/model 目标
 *   会被翻译成它所服务的 host 集合（见 providers.js），再按 host 判定。
 *   同一 host 上的其他模型会被一并代理 —— 这是传输层的物理限制，UI 里会显式提示。
 * - loopback 恒直连：本机代理自己、以及 DSH 的 web server 都在 127.0.0.1，
 *   把它们送进代理会直接死锁（连接自己）。
 */

/** 允许的策略模式。 */
export const POLICY_MODES = Object.freeze(["off", "allowlist", "everything"]);

/** 单个匹配目标的三种形态。 */
export const TARGET_KINDS = Object.freeze(["host", "provider", "model"]);

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

/**
 * 判断一个 host 是否属于回环/未指定地址。
 * 与宿主 `@deepseek-ai/dsh-http-proxy` 的 `isLoopbackHost` 保持同一套判定：
 * 整个 127.0.0.0/8、::1、0.0.0.0，以及 IPv4 映射写法（::ffff:127.0.0.1）。
 *
 * @param {string} hostname 已去掉方括号的 host（url.hostname 的形态）
 * @returns {boolean}
 */
export function isLoopbackHost(hostname) {
  if (typeof hostname !== "string" || hostname === "") return true;
  const host = hostname.toLowerCase();
  if (LOOPBACK_NAMES.has(host)) return true;
  // IPv4 映射写法：::ffff:127.0.0.1 / ::ffff:7f00:1
  const mapped = host.startsWith("::ffff:") ? host.slice(7) : host;
  if (mapped !== host && isLoopbackHost(mapped)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped);
  if (v4 === null) return false;
  const octets = v4.slice(1, 5).map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 127;
}

/**
 * 从 `provider/model` 里切出 provider id。
 * 模型 id 本身可以含 `/`（如 `anthropic/claude-3`），所以只在第一个 `/` 处切一次。
 *
 * @param {string} entry
 * @returns {{provider: string, model: string|undefined}}
 */
export function splitTarget(entry) {
  const slash = entry.indexOf("/");
  if (slash <= 0) return { provider: entry, model: undefined };
  return { provider: entry.slice(0, slash), model: entry.slice(slash + 1) };
}

/**
 * 把一条用户输入的匹配项归一化成 `{kind, ...}` 记录。
 * 认得 provider id 的集合已知时按 provider 归类，否则按 host 模式归类——
 * 但更稳的判据是形态：`provider/model` 是模型，含 `*`/前导 `.`/带端口的是 host，
 * 其余按 provider id 处理（provider.js 里查不到就退回 host，用户仍可用 `*.domain` 显式写）。
 *
 * @param {string} raw
 * @param {(provider: string) => boolean} [knownProvider]
 * @returns {{kind: "host"|"provider"|"model", provider?: string, model?: string, pattern?: string}|null}
 */
export function normalizeTarget(raw, knownProvider) {
  if (typeof raw !== "string") return null;
  const entry = raw.trim();
  if (entry === "" || entry.startsWith("#")) return null;
  if (entry === "*") return { kind: "host", pattern: "*" };

  const { provider, model } = splitTarget(entry);
  if (model !== undefined && model !== "") {
    return { kind: "model", provider, model };
  }
  // 明显的 host 形态：带端口、带通配、或含点且不是已知 provider
  const looksLikeHost =
    entry.includes(":") ||
    entry.includes("*") ||
    entry.startsWith(".") ||
    (entry.includes(".") && knownProvider !== undefined && !knownProvider(entry));
  if (looksLikeHost) return { kind: "host", pattern: entry.toLowerCase() };
  return { kind: "provider", provider: entry };
}

/**
 * 归一化整份勾选列表，去重、丢弃无法识别的项。
 *
 * @param {readonly string[]} entries
 * @param {(provider: string) => boolean} [knownProvider]
 */
export function normalizeTargets(entries, knownProvider) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of entries) {
    const target = normalizeTarget(raw, knownProvider);
    if (target === null) continue;
    const key = target.kind === "host" ? `host:${target.pattern}` : `${target.kind}:${target.provider}/${target.model ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

/**
 * host 模式匹配。支持：
 * - `*` 全部主机
 * - `api.example.com` 精确（大小写不敏感）
 * - `.example.com` / `*.example.com` 本域及其子域
 * - `api.example.com:443` 指定端口，`:*` / `:any` 表示任意端口
 *
 * @param {string} pattern
 * @param {string} hostname
 * @param {string} [port]
 * @returns {boolean}
 */
export function hostMatches(pattern, hostname, port) {
  if (typeof pattern !== "string" || typeof hostname !== "string") return false;
  if (pattern === "*") return true;
  let hostPattern = pattern;
  let portPattern;
  const colon = pattern.lastIndexOf(":");
  // 只有当冒号后是端口形态（数字 / * / any）时才当作端口，避免误伤 IPv6 字面量
  if (colon > 0 && /^(?:\d+|\*|any)$/i.test(pattern.slice(colon + 1))) {
    hostPattern = pattern.slice(0, colon);
    portPattern = pattern.slice(colon + 1).toLowerCase();
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // 模式本身也可能带 IPv6 方括号（`[::1]`），两边都要剥
  const barePattern = hostPattern.replace(/^\[|\]$/g, "");
  if (portPattern !== undefined && portPattern !== "*" && portPattern !== "any") {
    if (String(port ?? "") !== portPattern) return false;
  }
  if (barePattern.startsWith("*.") || barePattern.startsWith(".")) {
    const suffix = barePattern.slice(barePattern.startsWith("*.") ? 1 : 0);
    return host === suffix.slice(1) || host.endsWith(suffix);
  }
  if (barePattern.includes("*")) {
    const escaped = barePattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
    return new RegExp(`^${escaped}$`).test(host);
  }
  return host === barePattern;
}

/**
 * 默认端口，用于 host 模式里省略端口时的补齐。
 *
 * @param {string} url
 * @returns {string}
 */
function effectivePort(url) {
  if (url.port !== "") return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

/**
 * 归一化用户填的代理地址：
 * - 空 → 不启用
 * - `127.0.0.1:2080` → `http://127.0.0.1:2080`（缺 scheme 按 http 处理，本地代理几乎都是 http）
 * - 非 http/https scheme（如 socks5://）→ 明确拒绝，因为 undici ProxyAgent 不支持 SOCKS
 *
 * @param {string} raw
 * @returns {{ok: true, url: string}|{ok: false, reason: string}}
 */
export function normalizeProxyUrl(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "代理地址为空" };
  let text = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: `代理地址无法解析：${raw}` };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    return { ok: true, url: url.toString().replace(/\/$/, "") };
  }
  return { ok: false, reason: `不支持的代理协议 ${url.protocol}（仅支持 http/https，不支持 SOCKS/PAC）` };
}

/**
 * 生成判定函数。
 *
 * @param {object} options
 * @param {string} options.mode `off` | `allowlist` | `everything`
 * @param {readonly object[]} options.targets `normalizeTargets` 的产物
 * @param {readonly string[]} [options.bypassHosts] 永远直连的 host 模式（优先级最高）
 * @param {(provider: string) => readonly string[]} options.hostsForProvider provider/model 目标 → host 列表
 * @returns {(url: URL|string) => boolean} true = 走代理
 */
export function createDecider({ mode, targets, bypassHosts = [], hostsForProvider }) {
  // everything 不需要勾选项；allowlist 空勾选等于"全部直连"，因此不激活。
  const active = mode === "everything" || (mode === "allowlist" && Array.isArray(targets) && targets.length > 0);
  const bypass = normalizeTargets(bypassHosts, () => false);
  const resolve = typeof hostsForProvider === "function" ? hostsForProvider : () => [];

  return (input) => {
    if (!active) return false;
    let url;
    try {
      url = input instanceof URL ? input : new URL(String(input));
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const host = url.hostname;
    const port = effectivePort(url);
    // 回环恒直连：否则本机 web server / 代理自身会被送进代理形成死锁
    if (isLoopbackHost(host)) return false;
    for (const item of bypass) {
      if (item.kind === "host" && hostMatches(item.pattern, host, port)) return false;
    }
    if (mode === "everything") return true;
    for (const item of targets) {
      if (item.kind === "host") {
        if (hostMatches(item.pattern, host, port)) return true;
        continue;
      }
      const hosts = resolve(item.provider);
      for (const candidate of hosts) {
        if (hostMatches(candidate, host, port) || hostMatches(candidate, host)) return true;
      }
    }
    return false;
  };
}

/**
 * 把勾选项翻译成「人类可读的影响面」描述，供设置界面展示。
 * 返回每个 provider/model 目标实际覆盖的 host，便于用户知道勾选的影响范围。
 *
 * @param {readonly object[]} targets
 * @param {(provider: string) => readonly string[]} hostsForProvider
 * @returns {{provider: string, model: string|undefined, hosts: string[]}[]}
 */
export function describeCoverage(targets, hostsForProvider) {
  if (!Array.isArray(targets)) return [];
  return targets
    .filter((item) => item.kind !== "host")
    .map((item) => ({
      provider: item.provider,
      model: item.model,
      hosts: [...new Set(hostsForProvider(item.provider))],
    }));
}