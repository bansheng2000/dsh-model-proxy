/**
 * dsh-model-proxy — provider / model → 出站 host 映射
 *
 * 核心约束（决定了整个实现形态）：
 * DSH 的 `llm` 服务**没有** per-request dispatcher / fetch 注入点。
 * - `LlmAdapter` 只有 `prepareCall` / `stream(options)`，adapter 自己发请求；
 * - `agent/request` waterfall 返回的 `LlmCallConfig` 只有 provider/model/reasoningEffort/
 *   temperature/maxTokens/stop，**没有 baseURL 字段**，改写出站地址是不可能的；
 * - pi-ai 栈内部用 `globalThis.fetch`，也就是 undici 的全局 dispatcher。
 *
 * 所以唯一的可编程点是全局 dispatcher，而 dispatcher 只看得到 origin（`host:port`）。
 * 于是「勾选某个供应商走代理」必须先翻译成「这个供应商会打哪些 host 走代理」。
 *
 * host 来源，按可信度排序：
 * 1. 运行期实测：用户在界面上点「测试」，我们对候选 baseURL 各发一个请求，
 *    记录真实出站 origin。**这是唯一能覆盖自定义/中转/网关地址的可靠来源。**
 * 2. 配置声明：`llm` / `llm-pi-ai` / 各 provider 命名空间里的 baseURL 字段。
 * 3. 已知供应商的出厂 host 常量（api.openai.com 等），作为未配置时的兜底。
 */

/**
 * 已知供应商的出厂 host 兜底表。只在配置里查不到 baseURL 时用。
 *
 * key 一律小写。同一家的多个 provider id（`deepseek` / `deepseek-official` /
 * `deepseek-account`）都列出来，因为 DSH 实际登记的 id 是带后缀的那种。
 */
export const KNOWN_PROVIDER_HOSTS = Object.freeze({
  openai: ["api.openai.com"],
  anthropic: ["api.anthropic.com"],
  deepseek: ["api.deepseek.com"],
  "deepseek-official": ["api.deepseek.com"],
  "deepseek-account": ["api.deepseek.com"],
  google: ["generativelanguage.googleapis.com"],
  gemini: ["generativelanguage.googleapis.com"],
  openrouter: ["openrouter.ai"],
  moonshot: ["api.moonshot.cn"],
  kimi: ["api.moonshot.cn"],
  qwen: ["dashscope.aliyuncs.com"],
  dashscope: ["dashscope.aliyuncs.com"],
  zhipu: ["open.bigmodel.cn"],
  glm: ["open.bigmodel.cn"],
  doubao: ["ark.cn-beijing.volces.com"],
  volcengine: ["ark.cn-beijing.volces.com"],
  groq: ["api.groq.com"],
  mistral: ["api.mistral.ai"],
  xai: ["api.x.ai"],
  together: ["api.together.xyz"],
  fireworks: ["api.fireworks.ai"],
  deepinfra: ["api.deepinfra.com"],
  siliconflow: ["api.siliconflow.cn"],
  bailian: ["dashscope.aliyuncs.com"],
});

/**
 * 配置里可能藏 baseURL 的字段名。不同 provider 的命名空间写法不统一，
 * 这里用一组宽泛的候选名去探测，避免为每个 provider 硬编码一份 schema。
 */
const BASE_URL_KEYS = Object.freeze([
  "baseURL",
  "baseUrl",
  "apiBase",
  "apiBaseUrl",
  "api_base",
  "endpoint",
  "url",
  "host",
]);

/**
 * 这些字段不是 baseURL，别误当成主机名。
 */
const URL_KEY_BLOCKLIST = new Set(["apiKey", "api_key", "key", "token", "secret", "password", "model", "id"]);

/**
 * 从任意对象里递归捞出可能的 baseURL 字符串。
 * 限制深度和节点数，避免在巨大的配置树上跑失控。
 *
 * @param {unknown} node
 * @param {number} [depth]
 * @param {Set<string>} [found]
 * @returns {Set<string>}
 */
export function collectBaseUrls(node, depth = 0, found = new Set()) {
  if (depth > 6 || found.size > 64) return found;
  if (typeof node === "string") {
    const text = node.trim();
    if (/^https?:\/\//i.test(text) && text !== "http://" && text !== "https://") found.add(text);
    return found;
  }
  if (node === null || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const item of node) collectBaseUrls(item, depth + 1, found);
    return found;
  }
  for (const [key, value] of Object.entries(node)) {
    if (URL_KEY_BLOCKLIST.has(key)) continue;
    if (typeof value === "string" && BASE_URL_KEYS.some((candidate) => key.toLowerCase() === candidate.toLowerCase())) {
      const text = value.trim();
      if (/^https?:\/\//i.test(text)) found.add(text);
      continue;
    }
    collectBaseUrls(value, depth + 1, found);
  }
  return found;
}

/**
 * 把 baseURL 归一化成可匹配的 host 形式。
 * `https://api.example.com/v1` → `api.example.com`（host，模式里可比对）
 * 同时保留带端口的形式，因为同 host 不同端口可能是完全不同的后端。
 *
 * @param {string} raw
 * @returns {string|null}
 */
export function hostOf(raw) {
  try {
    const url = new URL(raw);
    return url.port === "" ? url.hostname.toLowerCase() : `${url.hostname.toLowerCase()}:${url.port}`;
  } catch {
    return null;
  }
}

/**
 * 判断某个 baseURL 是否属于给定 provider。
 * - provider 显式声明的 baseURL 直接采信（`exact`）
 * - 否则看 host 是否和已知出厂 host 一致（`known`）
 * - 都不中就返回 `undefined`，由调用方决定是否收录（默认不收，避免误代理）
 *
 * @param {string} provider
 * @param {string} baseUrl
 * @returns {"exact"|"known"|undefined}
 */
export function attributionOf(provider, baseUrl) {
  const host = hostOf(baseUrl);
  if (host === null) return undefined;
  const bare = host.split(":")[0];
  const known = KNOWN_PROVIDER_HOSTS[provider.toLowerCase()];
  if (Array.isArray(known) && known.some((entry) => bare === entry || host === entry)) return "known";
  return undefined;
}

/**
 * 组装一个 host 查询器。
 *
 * @param {object} sources
 * @param {Record<string, readonly string[]>} [sources.declared] provider → 配置里声明的 baseURL host
 * @param {Record<string, readonly string[]>} [sources.observed] provider → 运行期实测到的 origin host
 * @param {(provider: string) => readonly string[]} [sources.fallback] 出厂常量兜底
 * @returns {(provider: string) => string[]}
 */
export function createHostResolver({ declared = {}, observed = {}, fallback } = {}) {
  const fallbackResolver =
    typeof fallback === "function"
      ? fallback
      : (provider) => KNOWN_PROVIDER_HOSTS[provider.toLowerCase()] ?? [];
  return (provider) => {
    if (typeof provider !== "string" || provider === "") return [];
    const key = provider.toLowerCase();
    const merged = [];
    const push = (list) => {
      for (const item of list ?? []) {
        const host = hostOf(item) ?? String(item).toLowerCase();
        if (host !== "" && !merged.includes(host)) merged.push(host);
      }
    };
    // 实测值最准（能覆盖中转/网关），声明值次之，出厂常量垫底
    push(observed[key]);
    push(declared[key]);
    push(fallbackResolver(provider));
    return merged;
  };
}

/**
 * 汇总当前 profile 里所有已知 provider，供界面勾选。
 *
 * `providers` 接受两种形态：`llm.listProviders()` 返回的是 `LlmProviderInfo[]`
 * （`{ id, name }`），而测试里常直接传字符串数组，两种都要吃下。
 *
 * @param {object} input
 * @param {readonly (string | {id?: string, name?: string})[]} input.providers `ctx.llm.listProviders()`
 * @param {Record<string, unknown>} [input.providerConfig] provider id → 其配置命名空间的内容
 * @param {readonly {provider: string, models: readonly string[]}[]} [input.discovered] 模型发现结果
 * @returns {{provider: string, displayName: string, hosts: string[], models: string[]}[]}
 */
export function buildCatalog({ providers, providerConfig = {}, discovered = [] }) {
  const declared = {};
  for (const [provider, config] of Object.entries(providerConfig)) {
    declared[provider.toLowerCase()] = [...collectBaseUrls(config)];
  }
  const hostResolver = createHostResolver({ declared });
  const modelsByProvider = new Map();
  for (const entry of discovered) {
    if (entry === null || typeof entry !== "object" || typeof entry.provider !== "string") continue;
    const list = modelsByProvider.get(entry.provider) ?? [];
    for (const model of entry.models ?? []) if (!list.includes(model)) list.push(model);
    modelsByProvider.set(entry.provider, list);
  }
  const rows = [];
  const seen = new Set();
  for (const item of providers ?? []) {
    const provider = typeof item === "string" ? item : item?.id;
    if (typeof provider !== "string" || provider === "" || seen.has(provider)) continue;
    seen.add(provider);
    const config = providerConfig[provider];
    const infoName = typeof item === "string" ? undefined : item?.name;
    rows.push({
      provider,
      displayName: readDisplayName(config) ?? (typeof infoName === "string" && infoName !== "" ? infoName : provider),
      hosts: hostResolver(provider),
      models: modelsByProvider.get(provider) ?? [],
    });
  }
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return rows;
}

/**
 * 从 provider 配置里读显示名，读不到就用 provider id。
 *
 * @param {unknown} config
 * @returns {string|undefined}
 */
export function readDisplayName(config) {
  if (config === null || typeof config !== "object") return undefined;
  for (const key of ["displayName", "label", "name", "title"]) {
    const value = config[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}