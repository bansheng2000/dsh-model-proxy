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
import { normalizeProxyUrl } from "./policy.js";

const BRIDGE_PREFIX = "/api/dsh-model-proxy-settings";
const MAX_JSON_BODY_BYTES = 256 * 1024;
// 模块求值时刻。用来回答「磁盘上的 lib 改动到底被加载了吗」。
const MODULE_LOADED_AT = Date.now();

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
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
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: "loopback requests only" });
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

    /** 写配置。只允许改本插件自己的命名空间。 */
    async mutate(body) {
      if (body === null || typeof body !== "object" || !Array.isArray(body.ops)) {
        return { ok: false, code: "settings-rejected", message: "malformed bridge settings request" };
      }
      if (String(body.ns ?? ns) !== ns) {
        return { ok: false, code: "settings-not-exposed", message: `settings namespace "${body.ns}" is not exposed` };
      }
      for (const op of body.ops) {
        if (op === null || typeof op !== "object" || typeof op.path?.[0] !== "string") {
          return { ok: false, code: "settings-rejected", message: "malformed settings op" };
        }
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