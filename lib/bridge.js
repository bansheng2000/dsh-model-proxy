/**
 * dsh-model-proxy — 设置桥（HTTP）
 *
 * 前端卡片通过这些路由读写配置。放在 plugin 自己名下而不是用宿主生成的表单，
 * 因为「勾选供应商」这种列表交互用 schema 表单表达不了。
 *
 * 沿用 dsh-free-search 的桥约定：
 * - 前缀 `/api/dsh-model-proxy-settings`
 * - 只接受回环来源 + POST（写）/ GET（读）
 * - 一律 `{ok: true, value}` / `{ok: false, code, message}` 包裹
 */

import { buildCatalog, collectBaseUrls, createHostResolver, hostOf, readDisplayName } from "./providers.js";
import { POLICY_MODES, isLoopbackHost, normalizeProxyUrl } from "./policy.js";

const BRIDGE_PREFIX = "/api/dsh-model-proxy-settings";
const MAX_JSON_BODY_BYTES = 256 * 1024;
// 模块求值时刻。用来回答「磁盘上的 lib 改动到底被加载了吗」。
const MODULE_LOADED_AT = Date.now();

/** Rules schema 里可写的字段（与 lib/index.js 的 Rules 一一对应，改一处要同步另一处）。 */
const MUTABLE_FIELDS = new Set(["enabled", "mode", "proxyUrl", "selected", "bypass"]);
const MUTABLE_MODES = new Set(POLICY_MODES);
const MAX_LIST_ITEMS = 200;
const MAX_ENTRY_CHARS = 253;
const MAX_PROXY_URL_CHARS = 2048;

/**
 * 校验一条 settings op。返回 null 表示放行，否则返回拒绝原因。
 *
 * 为什么要在桥这层挡：宿主对 schema 里不存在的字段是**静默丢弃**的——op 报成功、
 * 配置里却不会出现，用户以为保存成功（审查实测 `["rules","bogusKey"]` → ok=true 但无此键）。
 * 这里只放行真实字段并顺手把类型/长度封顶，攻击面也跟着收窄。
 *
 * @param {unknown} op
 * @returns {string|null}
 */
function checkMutateOp(op) {
  if (op === null || typeof op !== "object") return "malformed settings op";
  if (String(op.op ?? "set") !== "set") return `unsupported settings op "${op.op}"`;
  const path = op.path;
  if (!Array.isArray(path) || path.length !== 2 || path[0] !== "rules" || typeof path[1] !== "string") {
    return `only rules.<field> can be written, got ${JSON.stringify(path)}`;
  }
  const field = path[1];
  if (!MUTABLE_FIELDS.has(field)) return `unknown config field "rules.${field}"`;
  const value = op.value;
  if (field === "enabled") {
    return typeof value === "boolean" ? null : "enabled must be a boolean";
  }
  if (field === "mode") {
    return MUTABLE_MODES.has(value) ? null : `mode must be one of ${POLICY_MODES.join(" / ")}`;
  }
  if (field === "proxyUrl") {
    if (typeof value !== "string") return "proxyUrl must be a string";
    if (value.length > MAX_PROXY_URL_CHARS) return `proxyUrl is too long (${value.length} > ${MAX_PROXY_URL_CHARS})`;
    return null;
  }
  // selected / bypass：字符串数组；条数与单条长度都封顶，免得有人往配置里灌大数组
  if (!Array.isArray(value)) return `${field} must be a string array`;
  if (value.length > MAX_LIST_ITEMS) return `${field} has too many entries (${value.length} > ${MAX_LIST_ITEMS})`;
  for (const entry of value) {
    if (typeof entry !== "string") return `${field} entries must be strings`;
    if (entry.length > MAX_ENTRY_CHARS) return `${field} entry is too long (${entry.length} > ${MAX_ENTRY_CHARS})`;
  }
  return null;
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    // 超限后不再攒内存，但要把 body 读完：中途 return 会让 async iterator 销毁请求流，
    // 连接停在半开、响应发不出去，socket 还被占着。
    if (tooLarge) continue;
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * 只接受回环来源。桥能改配置、能触发探测，不能暴露给局域网。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
export function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress;
  if (typeof address !== "string") return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}

/**
 * 请求准入检查。返回 `{ok: true}`，或 `{ok: false, status, code, message}`。
 *
 * 为什么不能只看 `req.socket.remoteAddress`：本机常驻的 cloudflared 快速隧道会把
 * 公网请求以 127.0.0.1 送达（2026-10-17 实测：公网无凭据 GET 也能拿到 200），
 * 而攻击页面又跑在用户浏览器里、来源天然是回环。**挡隧道只能靠 Host 头**：
 *
 * - `Host` 必须回环 —— 隧道会带自己的公网主机名，这条挡它；也顺带挡 DNS rebinding
 *   （域名反弹到回环后，浏览器发的 Host 仍是攻击者那个域名）。
 * - `Origin` 有值时也必须回环，且与 Host 的 host:port 对齐（挡跨站 CSRF）。
 * - 非 GET/HEAD 必须自带 `application/json`：浏览器跨站「简单请求」发不出这个类型，
 *   要发就得先预检，而预检我们不答（415 content-type-not-json）。
 *
 * 这不是鉴权 —— 本机任意进程都能伪造这几个头。要真鉴权得迁到宿主鉴权面
 * `ctx.connection.fetch.register`（见 README「已知限制」）。
 *
 * 侧效：经隧道（`https://<随机名>.dsh-market.com`）打开 GUI 时本插件卡片会被 403 挡下。
 * 这是刻意取舍 —— 隧道公网可达，而这块路由能改用户的代理出口。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {{ok: true}|{ok: false, status: number, code: string, message: string}}
 */
export function inspectRequest(req) {
  if (!isLoopbackRequest(req)) {
    return { ok: false, status: 403, code: "address-not-loopback", message: "loopback requests only" };
  }
  const rawHost = typeof req.headers?.host === "string" ? req.headers.host.trim().toLowerCase() : "";
  const hostName = hostnameOfHeader(rawHost);
  if (hostName === "" || !isLoopbackHost(hostName)) {
    return {
      ok: false,
      status: 403,
      code: "host-not-loopback",
      message: `host header must be loopback, got "${rawHost}"`,
    };
  }
  const origin = req.headers?.origin;
  if (origin !== undefined && origin !== "" && !originMatchesHost(origin, rawHost)) {
    return {
      ok: false,
      status: 403,
      code: "origin-not-trusted",
      message: `origin "${origin}" is not trusted for host "${rawHost}"`,
    };
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !isJsonRequest(req)) {
    return { ok: false, status: 415, code: "content-type-not-json", message: "content-type must be application/json" };
  }
  return { ok: true };
}

/** Origin 必须回环，且与 Host 的 host:port 对齐（Host 没写端口时只比主机名）。 */
function originMatchesHost(origin, rawHost) {
  let parsed = null;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const originHost = stripBrackets(parsed.hostname.toLowerCase());
  if (!isLoopbackHost(originHost)) return false;
  if (hostnameOfHeader(rawHost) !== originHost) return false;
  const hostPort = portOfHeader(rawHost);
  return hostPort === null || hostPort === effectivePortOf(parsed);
}

/** `[::1]` → `::1`（URL.hostname 保留方括号，Host 头不保留，两边都要归一）。 */
function stripBrackets(name) {
  return name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
}

/** `Host: 127.0.0.1:19387` → "19387"；没写端口时返回 null。 */
function portOfHeader(host) {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 || trimmed[end + 1] !== ":" ? null : trimmed.slice(end + 2);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? null : trimmed.slice(colon + 1);
}

/** URL 的有效端口：显式端口优先，否则按协议取默认（https→443，其余→80）。 */
function effectivePortOf(parsed) {
  if (parsed.port !== "") return parsed.port;
  return parsed.protocol === "https:" ? "443" : "80";
}

/** `Host: [::1]:19387` / `Host: example.com:443` → 主机名（小写）。 */
function hostnameOfHeader(host) {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end === -1 ? trimmed : trimmed.slice(1, end);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

/**
 * 写路由只接受 application/json。
 *
 * 浏览器跨站「简单请求」只能发 text/plain、application/x-www-form-urlencoded、
 * multipart/form-data 三种安全类型（不触发预检），发不出 application/json；
 * 所以这条检查单独就能让盲写 CSRF 失效。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
export function isJsonRequest(req) {
  const raw = req.headers?.["content-type"];
  if (typeof raw !== "string") return false;
  return raw.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * 从 settings 描述符里挖出各 provider 声明的 baseURL。
 *
 * provider 的配置散落在不同命名空间里，形态不统一：
 * - `llm-pi-ai.providers.<id>` —— 手工登记的兼容网关
 * - `llm.<id>` / 直接以 provider id 命名的命名空间
 * 所以这里两种形态都认，认不出的就跳过（宁可漏，不可错配到别的 provider）。
 *
 * @param {readonly object[]} descriptors `settings.describe({redactSecrets:true})`
 * @returns {Record<string, string[]>} provider（小写）→ baseURL 列表
 */
export function harvestDeclaredHosts(descriptors) {
  const out = {};
  const add = (provider, baseUrl) => {
    if (typeof provider !== "string" || provider === "") return;
    const key = provider.toLowerCase();
    const list = out[key] ?? [];
    if (!list.includes(baseUrl)) list.push(baseUrl);
    out[key] = list;
  };
  for (const descriptor of descriptors ?? []) {
    const value = descriptor?.value;
    if (value === null || typeof value !== "object") continue;
    const ns = String(descriptor.ns ?? "");
    // 形态一：命名空间里有 providers 表
    const providers = value.providers;
    if (providers !== null && typeof providers === "object" && !Array.isArray(providers)) {
      for (const [provider, route] of Object.entries(providers)) {
        for (const url of collectBaseUrls(route)) add(provider, url);
      }
      continue;
    }
    // 形态二：命名空间名本身就是 provider id（如 `llm-deepseek`）
    for (const url of collectBaseUrls(value)) add(ns, url);
  }
  return out;
}

/**
 * 建桥的路由表。
 *
 * @param {object} deps
 * @param {any} deps.settings settings 服务
 * @param {string} deps.ns 本插件的命名空间
 * @param {() => Promise<{ok: boolean, reason?: string, mode: string}>} deps.getStatus 当前生效状态
 * @param {() => Record<string, unknown>} deps.getConfig 当前配置（普通值）
 * @param {() => Promise<readonly string[]>} deps.listProviders
 * @param {() => Promise<Record<string, string[]>>} [deps.getObserved] 实测到的 host
 * @param {(payload: object) => Promise<{ok: boolean, message?: string}>} [deps.probe] 实跑探测
 * @returns {{kind: "exact", path: string, handler: Function}[]}
 */
export function makeBridgeRoutes(deps) {
  const { settings, ns, getStatus, getConfig, listProviders, getObserved, probe } = deps;

  const guard = (req, res, method) => {
    // 准入门槛全在 inspectRequest 里：Host 必须回环（挡 cloudflared 隧道与 DNS
    // rebinding）、Origin 有值时必须回环且与 Host 对齐（挡跨站 CSRF）、非
    // GET/HEAD 必须自带 application/json。这里只负责把拒因原样写回去。
    const verdict = inspectRequest(req);
    if (!verdict.ok) {
      writeJson(res, verdict.status, { error: verdict.message, code: verdict.code });
      return false;
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method ?? ""}` });
      return false;
    }
    return true;
  };

  const handlers = {
    /** 读当前配置 + 生效状态，前端用它渲染。 */
    async describe() {
      try {
        const descriptor = settings
          .describe({ redactSecrets: true })
          .find((candidate) => String(candidate.ns) === ns);
        const status = await getStatus();
        return { ok: true, value: { ns, config: getConfig(), descriptor, status } };
      } catch (error) {
        return { ok: false, code: "describe-failed", message: messageOf(error) };
      }
    },

    /** 列出可勾选的 provider 及其实际会命中的 host。 */
    async catalog() {
      try {
        const descriptors = settings.describe({ redactSecrets: true });
        const declared = harvestDeclaredHosts(descriptors);
        const providerConfig = {};
        for (const [provider, urls] of Object.entries(declared)) {
          providerConfig[provider] = { baseURL: urls[0] };
        }
        // llm 是可选 seam，可能缺席也可能抛错。任一情况都不能让整页崩成空列表：
        // 降级成「出厂 host 表」——用户至少还能勾选已知 provider。
        let providers = [];
        let providerError = null;
        try {
          providers = (await listProviders()) ?? [];
        } catch (error) {
          providerError = messageOf(error);
        }
        // declared 里声明过的 provider 也应出现在列表里，即便 llm 没登记它
        // （例如 llm seam 缺席时）。否则用户无从勾选。
        // 但要排掉本插件自己：它的 proxyUrl 会被当成「声明过的 baseURL」，
        // 于是界面上多出一个叫 model-proxy、指向 127.0.0.1:2080 的条目——
        // 勾它毫无意义（回环恒直连），只是噪声。
        const merged = [...providers];
        for (const provider of Object.keys(declared)) {
          if (provider.toLowerCase() === ns.toLowerCase()) continue;
          const id = provider.toLowerCase();
          const known = merged.some(
            (item) => (typeof item === "string" ? item : String(item?.id ?? "")).toLowerCase() === id,
          );
          if (!known) merged.push({ id: provider, name: readDisplayName(providerConfig[provider]) ?? provider });
        }
        const observed = (await getObserved?.()) ?? {};
        const rows = buildCatalog({
          providers: merged,
          providerConfig,
          discovered: [],
        });
        // 实测 host 覆盖已知常量，用户能看到"这个勾选到底会影响哪些地址"
        const hostResolver = createHostResolver({ declared, observed });
        for (const row of rows) row.hosts = hostResolver(row.provider);
        return {
          ok: true,
          value: {
            rows,
            observed,
            // 诊断用：llm seam 是否真的拿到了、拿到了多少个 provider。
            diagnostics: {
              moduleLoadedAt: MODULE_LOADED_AT,
              providerError,
              providerCount: providers.length,
              mergedCount: merged.length,
              rawProviderSample: JSON.parse(JSON.stringify(providers.slice(0, 3))),
              descriptorNamespaces: (descriptors ?? []).map((d) => String(d?.ns ?? "")).slice(0, 40),
              declaredProviderKeys: Object.keys(declared),
            },
          },
        };
      } catch (error) {
        return { ok: false, code: "catalog-failed", message: messageOf(error) };
      }
    },

    /** 写配置。只允许改本插件自己的命名空间，且只允许改 Rules 里真实存在的字段。 */
    async mutate(body) {
      if (body === null || typeof body !== "object" || !Array.isArray(body.ops)) {
        return { ok: false, code: "settings-rejected", message: "malformed bridge settings request" };
      }
      if (String(body.ns ?? ns) !== ns) {
        return { ok: false, code: "settings-not-exposed", message: `settings namespace "${body.ns}" is not exposed` };
      }
      for (const op of body.ops) {
        const rejected = checkMutateOp(op);
        if (rejected !== null) return { ok: false, code: "settings-rejected", message: rejected };
      }
      try {
        await settings.mutate(ns, body.ops, typeof body.expectedRevision === "number" ? body.expectedRevision : undefined);
      } catch (error) {
        return { ok: false, code: "settings-write-failed", message: messageOf(error) };
      }
      return handlers.describe();
    },

    /**
     * 实跑探测：对给定地址发一个真实请求，验证它到底走代理还是直连。
     * 这是唯一能证明"代理配对了"的方法——配置对了不代表 NekoBox 在监听。
     */
    async probeTarget(body) {
      if (probe === undefined) return { ok: false, code: "probe-unavailable", message: "probe is not available" };
      try {
        return { ok: true, value: await probe(body) };
      } catch (error) {
        return { ok: false, code: "probe-failed", message: messageOf(error) };
      }
    },

    /** 只校验代理地址格式，不发请求。 */
    async validateProxy(body) {
      const raw = body?.proxyUrl;
      const result = normalizeProxyUrl(typeof raw === "string" ? raw : "");
      if (!result.ok) return { ok: false, code: "invalid-proxy", message: result.reason };
      return { ok: true, value: { proxyUrl: result.url } };
    },

    /** 把一个地址解析成 host，供用户确认它会命中哪条规则。 */
    async explain(body) {
      const url = typeof body?.url === "string" ? body.url : "";
      let host = null;
      let port = null;
      try {
        const parsed = new URL(url);
        host = parsed.hostname;
        port = parsed.port;
      } catch {
        return { ok: false, code: "invalid-url", message: `无法解析：${url}` };
      }
      const status = await getStatus();
      return { ok: true, value: { host, port: port ?? null, hostOnly: hostOf(url), status } };
    },
  };

  return [
    { kind: "exact", path: `${BRIDGE_PREFIX}/describe`, handler: async (req, res) => {
      if (!guard(req, res, "GET")) return;
      writeJson(res, 200, await handlers.describe());
    } },
    { kind: "exact", path: `${BRIDGE_PREFIX}/catalog`, handler: async (req, res) => {
      if (!guard(req, res, "GET")) return;
      writeJson(res, 200, await handlers.catalog());
    } },
    { kind: "exact", path: `${BRIDGE_PREFIX}/mutate`, handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      const body = await readJsonBody(req);
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: "settings-rejected", message: "malformed JSON body" });
        return;
      }
      writeJson(res, 200, await handlers.mutate(body));
    } },
    { kind: "exact", path: `${BRIDGE_PREFIX}/probe`, handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      const body = await readJsonBody(req);
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: "probe-rejected", message: "malformed JSON body" });
        return;
      }
      writeJson(res, 200, await handlers.probeTarget(body));
    } },
    { kind: "exact", path: `${BRIDGE_PREFIX}/validate-proxy`, handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      const body = await readJsonBody(req);
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: "probe-rejected", message: "malformed JSON body" });
        return;
      }
      writeJson(res, 200, await handlers.validateProxy(body));
    } },
    { kind: "exact", path: `${BRIDGE_PREFIX}/explain`, handler: async (req, res) => {
      if (!guard(req, res, "POST")) return;
      const body = await readJsonBody(req);
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: "probe-rejected", message: "malformed JSON body" });
        return;
      }
      writeJson(res, 200, await handlers.explain(body));
    } },
  ];
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export { BRIDGE_PREFIX };