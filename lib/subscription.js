/**
 * dsh-model-proxy — 订阅解析
 *
 * 目标：把「机场订阅」变成一份节点清单，再交给本机内核（mihomo / sing-box）去跑。
 * 插件自己**不实现协议**——VLESS / Hysteria2 是传输协议，不是 HTTP 代理，
 * undici 的 ProxyAgent 说不了它们。插件只做控制面：
 *   订阅文本 → 节点清单 → 内核配置（PATCH /configs）→ 选一个可用节点。
 *
 * 支持三种订阅形态：
 *   1. Clash / mihomo YAML（`proxies:` 段）—— 最好办，几乎原样转发给内核；
 *   2. base64 分享链接列表（vless:// / hysteria2:// / trojan:// / ss:// / http://）；
 *   3. sing-box JSON（`outbounds`）—— 只取基本字段，复杂字段提示用户用内核自带的订阅功能。
 *
 * 解析绝不抛异常（订阅格式千奇百怪，抛了就整张卡片崩）；认不出的条目进 warnings。
 */

import { parse as parseYaml } from "yaml";

/** 单次订阅最多收多少节点：机场动辄几百条，再多也没人手动挑。 */
export const MAX_NODES = 2000;
/** 订阅文本大小上限（base64 展开后可能翻 1.3 倍，留点余量）。 */
export const MAX_SUBSCRIPTION_BYTES = 8 * 1024 * 1024;

/**
 * 解析订阅文本。
 *
 * @param {string} raw 订阅原文（可以是 base64 整段、YAML、JSON，或纯分享链接列表）
 * @param {{format?: "auto"|"share-links"|"clash-yaml"|"singbox-json"}} [options]
 * @returns {{ok: boolean, format: string, nodes: object[], warnings: string[], error?: string}}
 */
export function parseSubscription(raw, options = {}) {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: false, format: "none", nodes: [], warnings: [], error: "订阅内容为空" };
  const format = options.format ?? "auto";

  const decoded = format === "auto" || format === "share-links" ? tryBase64Text(text) : text;
  const body = decoded ?? text;

  if (format === "singbox-json" || (format === "auto" && looksLikeJson(body)) || (format === "auto" && looksLikeJson(text))) {
    const json = parseJson(body) ?? parseJson(text);
    if (json === null) return { ok: false, format: "singbox-json", nodes: [], warnings: [], error: "订阅不是合法 JSON" };
    return fromSingbox(json);
  }
  if (format === "clash-yaml" || (format === "auto" && looksLikeClash(body))) {
    const result = fromClashYaml(body);
    if (result.ok || format === "clash-yaml") return result;
    // auto 模式下 YAML 解析失败就再按分享链接试一次（有些机场虽然带 proxies: 但内容是 base64）
  }
  return fromShareLinks(body);
}

/** 分享链接列表（也兜底处理「每行带 # 注释」的纯文本）。 */
export function fromShareLinks(text) {
  const nodes = [];
  const warnings = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const node = parseShareLink(trimmed);
    if (node === null) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) warnings.push(`无法识别的分享链接：${redact(trimmed)}`);
      continue;
    }
    const key = `${node.protocol}|${node.server}|${node.port}|${node.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push(node);
    if (nodes.length >= MAX_NODES) {
      warnings.push(`节点超过 ${MAX_NODES} 个，后面的已忽略`);
      break;
    }
  }
  if (nodes.length === 0) {
    return { ok: false, format: "share-links", nodes, warnings, error: "没有解析出任何节点（既不是 YAML/JSON，也不是分享链接列表）" };
  }
  return { ok: true, format: "share-links", nodes, warnings };
}

/**
 * 单条分享链接 → 节点。
 *
 * 只保留「喂给内核必须的那些字段」：密钥类字段（uuid/password）不进日志、不回前端。
 *
 * @param {string} line
 * @returns {object|null}
 */
export function parseShareLink(line) {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(line);
  if (scheme === null) return null;
  const kind = scheme[1].toLowerCase();
  const hashAt = line.indexOf("#");
  const fragment = hashAt === -1 ? "" : line.slice(hashAt + 1);
  const noHash = hashAt === -1 ? line : line.slice(0, hashAt);

  if (kind === "ss") return parseShadowsocks(noHash, fragment);

  let url;
  try {
    url = new URL(noHash);
  } catch {
    return null;
  }
  const name = decodeURIComponent(fragment) || decodeURIComponent(url.username) || url.hostname;
  const port = Number(url.port);
  const protocol = kind === "hy2" ? "hysteria2" : kind;
  if (!["vless", "hysteria2", "trojan", "http", "https", "socks5"].includes(protocol)) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const q = url.searchParams;
  const node = {
    name,
    protocol,
    server: url.hostname,
    port,
    secret: decodeURIComponent(url.username || url.password || ""),
    sni: q.get("sni") ?? q.get("peer") ?? "",
    // 前端只显示这些；raw 留给 applyToCore 生成内核配置
    raw: line,
  };
  if (protocol === "vless") {
    node.extra = {
      security: q.get("security") ?? "none",
      network: q.get("type") ?? "tcp",
      flow: q.get("flow") ?? "",
      fingerprint: q.get("fp") ?? "",
      publicKey: q.get("pbk") ?? "",
      shortId: q.get("sid") ?? "",
      wsHost: q.get("host") ?? "",
      wsPath: q.get("path") ?? "",
      grpcService: q.get("serviceName") ?? "",
      skipCertVerify: q.get("allowInsecure") === "1" || q.get("insecure") === "1",
    };
  } else if (protocol === "hysteria2") {
    const auth = q.get("auth") ?? "";
    node.secret = decodeURIComponent(url.username || "") + (auth === "" ? "" : `:${decodeURIComponent(auth)}`);
    node.extra = {
      obfs: q.get("obfs") ?? "",
      obfsPassword: q.get("obfs-password") ?? "",
      skipCertVerify: q.get("insecure") === "1" || q.get("allowInsecure") === "1",
      upMbps: Number(q.get("upmbps") ?? 0) || 0,
      downMbps: Number(q.get("downmbps") ?? 0) || 0,
    };
  } else {
    node.extra = {};
  }
  return node;
}

/** ss://base64(method:password)@host:port#name 或 ss://base64(整条) 两种写法都认。 */
function parseShadowsocks(noHash, fragment) {
  const rest = noHash.slice("ss://".length);
  const at = rest.lastIndexOf("@");
  let method = "";
  let password = "";
  let host = "";
  let port = 0;
  if (at !== -1) {
    const head = decodeBase64Text(decodeURIComponent(rest.slice(0, at)));
    if (head === null) return null;
    const colon = head.indexOf(":");
    if (colon === -1) return null;
    method = head.slice(0, colon);
    password = head.slice(colon + 1);
    const hostPort = rest.slice(at + 1);
    const idx = hostPort.lastIndexOf(":");
    if (idx === -1) return null;
    host = hostPort.slice(0, idx);
    port = Number(hostPort.slice(idx + 1));
  } else {
    const decoded = decodeBase64Text(decodeURIComponent(rest));
    if (decoded === null) return null;
    const at2 = decoded.lastIndexOf("@");
    if (at2 === -1) return null;
    const cred = decoded.slice(0, at2);
    const hostPort = decoded.slice(at2 + 1);
    const colon = cred.indexOf(":");
    if (colon === -1) return null;
    method = cred.slice(0, colon);
    password = cred.slice(colon + 1);
    const idx = hostPort.lastIndexOf(":");
    if (idx === -1) return null;
    host = hostPort.slice(0, idx);
    port = Number(hostPort.slice(idx + 1));
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || method === "") return null;
  return {
    name: decodeURIComponent(fragment) || host,
    protocol: "ss",
    server: host,
    port,
    secret: password,
    sni: "",
    extra: { cipher: method },
    raw: noHash + (fragment === "" ? "" : `#${fragment}`),
  };
}

/** Clash / mihomo YAML：`proxies:` 段原样保留（mihomo 的字段命名就是它的原生格式）。 */
export function fromClashYaml(text) {
  let doc;
  try {
    doc = parseYaml(text);
  } catch (error) {
    return { ok: false, format: "clash-yaml", nodes: [], warnings: [], error: `YAML 解析失败：${messageOf(error)}` };
  }
  const proxies = doc?.proxies;
  if (!Array.isArray(proxies) || proxies.length === 0) {
    return { ok: false, format: "clash-yaml", nodes: [], warnings: [], error: "YAML 里没有 proxies 段" };
  }
  const nodes = [];
  const warnings = [];
  for (const proxy of proxies) {
    if (proxy === null || typeof proxy !== "object") continue;
    const name = typeof proxy.name === "string" ? proxy.name : "";
    const server = typeof proxy.server === "string" ? proxy.server : "";
    const port = Number(proxy.port);
    const type = typeof proxy.type === "string" ? proxy.type.trim() : "";
    if (name === "" || server === "" || type === "" || !Number.isInteger(port)) {
      // type 必须留下：Clash 条目是原样交给内核的，缺 type 内核会整批拒绝
      warnings.push("有一条 proxies 条目缺 name/type/server/port，已跳过");
      continue;
    }
    nodes.push({
      name,
      protocol: type.toLowerCase(),
      server,
      port,
      secret: String(proxy.uuid ?? proxy.password ?? ""),
      sni: String(proxy.servername ?? proxy.sni ?? ""),
      extra: {},
      // clash 条目本身就是内核配置：applyToCore 直接原样提交，无需再转换
      clash: proxy,
      raw: "",
    });
    if (nodes.length >= MAX_NODES) break;
  }
  return { ok: nodes.length > 0, format: "clash-yaml", nodes, warnings, error: nodes.length > 0 ? undefined : "proxies 段里没有可用节点" };
}

/** sing-box JSON：只取 outbounds 里的基本字段，其余交给用户自己的内核订阅。 */
export function fromSingbox(json) {
  const outbounds = Array.isArray(json?.outbounds) ? json.outbounds : [];
  const nodes = [];
  const warnings = [];
  for (const outbound of outbounds) {
    if (outbound === null || typeof outbound !== "object") continue;
    const type = String(outbound.type ?? "").toLowerCase();
    if (["direct", "block", "dns", "selector", "urltest"].includes(type)) continue;
    const server = typeof outbound.server === "string" ? outbound.server : "";
    const port = Number(outbound.server_port);
    if (server === "" || !Number.isInteger(port)) continue;
    nodes.push({
      name: String(outbound.tag ?? `${type}-${server}`),
      protocol: type,
      server,
      port,
      secret: String(outbound.uuid ?? outbound.password ?? ""),
      sni: String(outbound.tls?.server_name ?? ""),
      extra: {},
      raw: "",
    });
    if (nodes.length >= MAX_NODES) break;
  }
  if (nodes.length === 0) warnings.push("sing-box 配置里没有可导入的节点");
  return { ok: nodes.length > 0, format: "singbox-json", nodes, warnings, error: nodes.length > 0 ? undefined : "没有可导入的 outbound" };
}

/**
 * 节点 → mihomo 的 proxy 条目。
 *
 * vless / hysteria2 / trojan / ss 覆盖常见字段；其余协议原样返回 null（调用方给 warning）。
 *
 * @param {object} node
 * @returns {object|null}
 */
export function toMihomoProxy(node) {
  if (node?.clash !== undefined) return node.clash;
  const base = { name: node.name, type: node.protocol, server: node.server, port: node.port };
  const extra = node.extra ?? {};
  switch (node.protocol) {
    case "vless": {
      const proxy = { ...base, uuid: node.secret, udp: true };
      if (node.sni !== "") proxy.servername = node.sni;
      if (extra.flow !== "") proxy.flow = extra.flow;
      if (extra.fingerprint !== "") proxy["client-fingerprint"] = extra.fingerprint;
      if (extra.security === "tls" || extra.security === "reality") proxy.tls = true;
      if (extra.security === "reality") {
        proxy["reality-opts"] = { "public-key": extra.publicKey, "short-id": extra.shortId };
      }
      if (extra.network === "ws") {
        proxy.network = "ws";
        proxy["ws-opts"] = {
          path: extra.wsPath === "" ? "/" : extra.wsPath,
          headers: extra.wsHost === "" ? {} : { Host: extra.wsHost },
        };
      } else if (extra.network === "grpc") {
        proxy.network = "grpc";
        proxy["grpc-opts"] = { "grpc-service-name": extra.grpcService };
      } else {
        proxy.network = "tcp";
      }
      if (extra.skipCertVerify === true) proxy["skip-cert-verify"] = true;
      return proxy;
    }
    case "hysteria2": {
      const proxy = { ...base, password: node.secret, sni: node.sni || node.server };
      if (extra.obfs !== "") {
        proxy.obfs = extra.obfs;
        proxy["obfs-password"] = extra.obfsPassword;
      }
      if (extra.skipCertVerify === true) proxy["skip-cert-verify"] = true;
      if (extra.upMbps > 0) proxy.up = String(extra.upMbps);
      if (extra.downMbps > 0) proxy.down = String(extra.downMbps);
      return proxy;
    }
    case "trojan": {
      const proxy = { ...base, password: node.secret, udp: true };
      if (node.sni !== "") proxy.sni = node.sni;
      if (extra.skipCertVerify === true) proxy["skip-cert-verify"] = true;
      return proxy;
    }
    case "ss": {
      return { ...base, cipher: extra.cipher ?? "aes-128-gcm", password: node.secret, udp: true };
    }
    case "http":
    case "https": {
      const proxy = { ...base, tls: node.protocol === "https" };
      if (extra.skipCertVerify === true) proxy["skip-cert-verify"] = true;
      return proxy;
    }
    case "socks5":
      return { ...base, udp: true };
    default:
      return null;
  }
}

/**
 * 生成 PATCH /configs 的增量体：节点 + 一个 select 组。
 *
 * 只提交 proxies 和一个组，不动用户已有的规则 / 其他组（mihomo ≥1.16 的 PATCH
 * 是增量语义；老版本会整体覆盖，README 里写了这条边界）。
 *
 * @param {object[]} nodes
 * @param {{group?: string}} [options]
 * @returns {{proxies: object[], proxyGroups: object[], skipped: string[]}}
 */
export function buildCorePatch(nodes, options = {}) {
  const group = options.group ?? "DSH";
  const proxies = [];
  const skipped = [];
  const names = [];
  for (const node of nodes) {
    const proxy = toMihomoProxy(node);
    if (proxy === null) {
      skipped.push(`${node.name}（${node.protocol}）`);
      continue;
    }
    proxies.push(proxy);
    names.push(proxy.name);
  }
  return {
    proxies,
    proxyGroups: names.length === 0 ? [] : [{ name: group, type: "select", proxies: names }],
    skipped,
  };
}

/**
 * 拉订阅。用的就是全局 fetch —— 因此会经过本插件自己的分流决策：
 * 订阅域名在「走代理的域名」里就自动走代理（墙内的机场域名通常要这样）。
 *
 * @param {string} url
 * @param {{timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<{ok: boolean, text?: string, status?: number, error?: string}>}
 */
export async function fetchSubscription(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  const maxBytes = options.maxBytes ?? MAX_SUBSCRIPTION_BYTES;
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, error: `订阅地址无法解析：${redact(String(url))}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: `不支持的订阅协议 ${parsed.protocol}` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed.toString(), {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "clash.meta/1.18 dsh-model-proxy" },
    });
    if (!response.ok) return { ok: false, status: response.status, error: `订阅返回 HTTP ${response.status}` };
    const body = await response.text();
    if (body.length > maxBytes) return { ok: false, status: response.status, error: `订阅内容过大（${body.length} 字节）` };
    return { ok: true, status: response.status, text: body };
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? "订阅请求超时" : messageOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/**
 * 任意长度的 base64 → 文本；不是合法 base64 / 解出来是乱码就返回 null。
 *
 * ss 的 userinfo（base64("aes-256-gcm:pw")）可能只有十几个字符，所以这里不设长度下限。
 */
function decodeBase64Text(text) {
  const compact = String(text).replace(/\s+/g, "");
  if (compact.length === 0 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null;
  try {
    const decoded = Buffer.from(compact, "base64").toString("utf8");
    // 解出来通常是可见文本；全是乱码说明猜错了
    return /^[\x09\x0a\x0d\x20-\x7e\u4e00-\u9fa5]+$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

/** 整段 base64 订阅（机场的常见形态）。太短的（如 "hello"）不当订阅，返回 null。 */
export function tryBase64Text(text) {
  const compact = String(text).replace(/\s+/g, "");
  if (compact.length < 24) return null;
  const decoded = decodeBase64Text(compact);
  return decoded !== null && decoded.length >= 16 ? decoded : null;
}

function looksLikeJson(text) {
  return /^\s*[{[]/.test(text);
}

function looksLikeClash(text) {
  return /(^|\n)\s*proxies\s*:/.test(text);
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 日志/错误里不带出订阅密钥：只留 scheme + 主机。 */
export function redact(text) {
  return String(text).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1***@").slice(0, 160);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
