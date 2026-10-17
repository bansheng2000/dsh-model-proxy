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

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

/**
 * 通配 host 模式 → 已编译正则。
 * hostMatches 每个新 origin 都会被调用一次（undici 的 Agent factory 每见一个新 origin
 * 走一遍判定），而模式串是用户配置里那几条、几乎不变，没必要每次现编。
 * 上限存在的理由：模式来自用户输入，缓存不能无界 —— 满了整体丢弃重来，代价只是重编。
 */
const WILDCARD_CACHE = new Map();
const WILDCARD_CACHE_LIMIT = 512;

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

/** RFC1918 / 保留网段的前两段判定；IPv4 字面量与它的 IPv6 映射写法共用。 */
function isPrivateV4(a, b) {
  if (a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * 判断 host 是否落在内网 / 保留网段。
 *
 * 与 `isLoopbackHost` 刻意分开：回环是「本机自己」，这里是「局域网 / 云元数据」，
 * 探针两条都拒，但报错文案不同，用户才知道为什么被拒。
 * 覆盖 10/8、172.16/12、192.168/16、169.254/16（含云元数据 169.254.169.254）、
 * 100.64/10（CGNAT）、0/8，以及 IPv6 的 ULA（fc00::/7）与链路本地（fe80::/10）。
 *
 * 已知边界：只认字面量，**不解析 DNS** —— 解析到内网的公网域名会通过这一关。
 * 但那种域名必须先被用户列进 `selected` 才会被探到，所以实际可达面仍然收得住。
 *
 * @param {string} hostname url.hostname 的形态（IPv6 字面量带方括号也认）
 * @returns {boolean}
 */
export function isPrivateHost(hostname) {
  if (typeof hostname !== "string" || hostname === "") return true;
  // url.hostname 对 IPv6 字面量**带方括号**，而且 WHATWG 会把 `[::ffff:10.0.0.1]`
  // 规范化成 `[::ffff:a00:1]`（点分形式根本不出现），所以先剥括号、再认两种映射写法。
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.includes(":")) {
    const hexMapped = /^:{1,2}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hexMapped !== null) {
      const hi = Number.parseInt(hexMapped[1], 16);
      return isPrivateV4((hi >> 8) & 255, hi & 255);
    }
    const mapped = host.startsWith("::ffff:") ? host.slice(7) : host;
    const mappedV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(mapped);
    if (mappedV4 !== null) {
      const [a, b] = mappedV4.slice(1, 5).map(Number);
      return isPrivateV4(a, b);
    }
    // fc00::/7 唯一本地地址；fe80::/10 链路本地
    return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 === null) return false;
  const [a, b] = v4.slice(1, 5).map(Number);
  if ([a, b].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return isPrivateV4(a, b);
}

/**
 * 探针目标裁决。
 *
 * `/probe` 是本机进程里的 HTTP 客户端：不设限就是一个不挑食的 SSRF / 端口扫描器
 * （实测能靠状态码与耗时区分 127.0.0.1 上哪些端口开着）。而它在界面上的用途只是
 * 「验证我列出的域名到底走没走通」，所以这里只放行**用户已经列进 selected 的公网域名**。
 *
 * @param {{hostname?: string, port?: string, protocol?: string}} parsed 已解析的目标 URL
 * @param {{mode?: string, selected?: readonly string[]}} rules 当前配置
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function probeTargetVerdict(parsed, rules) {
  const hostname = String(parsed?.hostname ?? "").trim().toLowerCase();
  if (hostname === "") return { ok: false, reason: "地址里没有主机名" };
  if (isLoopbackHost(hostname)) return { ok: false, reason: "拒绝探测回环地址：本机服务不在分流范围内" };
  if (isPrivateHost(hostname)) return { ok: false, reason: "拒绝探测内网 / 保留网段地址" };
  if (String(rules?.mode ?? "off") === "everything") return { ok: true };

  const selected = Array.isArray(rules?.selected) ? rules.selected : [];
  // url.port 对默认端口返回空串，而清单里可能就写着 `api.example.com:443`，
  // 所以按协议补回有效端口，否则「显式写了端口的域名」永远探不通。
  const rawPort = parsed?.port;
  const port =
    rawPort === "" || rawPort === undefined
      ? parsed?.protocol === "https:"
        ? "443"
        : "80"
      : String(rawPort);
  const hit = selected.some(
    (entry) => typeof entry === "string" && hostMatches(entry, hostname, port),
  );
  if (!hit) {
    return { ok: false, reason: `该域名不在「走代理的域名」清单里，先把它加进去再测：${hostname}` };
  }
  return { ok: true };
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
    let regex = WILDCARD_CACHE.get(barePattern);
    if (regex === undefined) {
      const escaped = barePattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^.]*");
      // 不带 g / y 标志：test() 才不会跨调用留下 lastIndex 状态，缓存才是安全的
      regex = new RegExp(`^${escaped}$`);
      if (WILDCARD_CACHE.size >= WILDCARD_CACHE_LIMIT) WILDCARD_CACHE.clear();
      WILDCARD_CACHE.set(barePattern, regex);
    }
    return regex.test(host);
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
