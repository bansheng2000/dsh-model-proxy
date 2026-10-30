/**
 * dsh-model-proxy — 内核适配器（Clash / mihomo 兼容 REST API）
 *
 * 插件不实现 VLESS / Hysteria2 —— 那是传输协议，不是 HTTP 代理。真正跑节点的是
 * 本机内核（mihomo / Clash Verge / sing-box 的 clash_api）。插件只调它的 REST API：
 *   GET   /proxies                    列节点 + 每个节点的历史延迟
 *   GET   /proxies/{name}/delay?url=  让内核真实握手测延迟（插件自己 ping 没意义）
 *   PUT   /proxies/{group}            切换 select 组选中项（立即生效，不重启）
 *   PATCH /configs                    增量灌入订阅节点 + 一个 select 组
 *
 * 所有方法都不抛异常，统一返回 {ok:true, ...} / {ok:false, code, message}，
 * 因为调用方是设置卡片：一次网络抖动不该把整张卡片打成白屏。
 */

const DEFAULT_TIMEOUT_MS = 5000;
/** delay 测试本身要跑握手，给它单独的、宽松一点的超时。 */
const DELAY_TIMEOUT_MS = 8000;

/**
 * @param {{baseUrl: string, secret?: string, group?: string, timeoutMs?: number}} options
 */
export function createClashAdapter(options) {
  const group = options.group === undefined || options.group.trim() === "" ? "DSH" : options.group.trim();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = normalizeBase(options.baseUrl);

  async function call(path, { method = "GET", body, timeout = timeoutMs } = {}) {
    if (!base.ok) return base;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(base.url + path, {
        method,
        signal: controller.signal,
        headers: {
          ...(options.secret ? { authorization: "Bearer " + options.secret } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      try {
        json = text === "" ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      if (!response.ok) {
        return {
          ok: false,
          code: "http-" + response.status,
          message: (json && (json.message ?? json.error)) || text.slice(0, 200) || "HTTP " + response.status,
        };
      }
      return { ok: true, value: json };
    } catch (error) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        code: aborted ? "timeout" : "unreachable",
        message: aborted ? "内核 API 超时（" + timeout + "ms）" : error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    group,

    /** 内核在不在、是不是 Clash 兼容 API。 */
    async ping() {
      const result = await call("/version");
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      return { ok: true, version: String(result.value?.version ?? ""), meta: result.value?.meta === true };
    },

    /** 当前 select 组的成员与选中项；顺带带回每个成员的最近延迟。 */
    async list() {
      const result = await call("/proxies");
      if (!result.ok) return result;
      const proxies = result.value?.proxies ?? {};
      const entry = proxies[group];
      if (entry === undefined) {
        return { ok: false, code: "group-missing", message: "内核里没有名为「" + group + "」的代理组，先刷新订阅或改「代理组名」" };
      }
      const members = Array.isArray(entry.all) ? entry.all : [];
      const nodes = members.map((name) => {
        const proxy = proxies[name] ?? {};
        const history = Array.isArray(proxy.history) ? proxy.history : [];
        const last = history.length === 0 ? null : history[history.length - 1];
        return {
          name: String(name),
          protocol: String(proxy.type ?? "").toLowerCase(),
          latencyMs: typeof last?.delay === "number" && last.delay > 0 ? last.delay : null,
        };
      });
      return { ok: true, value: { current: typeof entry.now === "string" ? entry.now : null, nodes } };
    },

    /** 让内核自己握手测延迟（VLESS / Hysteria2 的真实往返只有它测得出）。 */
    async delay(name, { url = "https://www.gstatic.com/generate_204", timeoutMs: testTimeout = 3000 } = {}) {
      const limit = Math.max(1000, Math.min(30000, testTimeout));
      const query = "?url=" + encodeURIComponent(url) + "&timeout=" + limit;
      const result = await call("/proxies/" + encodeURIComponent(name) + "/delay" + query, { timeout: DELAY_TIMEOUT_MS });
      if (!result.ok) return { ok: false, code: result.code, message: result.message };
      const delay = Number(result.value?.delay ?? 0);
      return delay > 0 ? { ok: true, latencyMs: delay } : { ok: false, code: "no-delay", message: "内核没有返回延迟" };
    },

    /** 切换 select 组的选中节点。 */
    async select(name) {
      const result = await call("/proxies/" + encodeURIComponent(group), { method: "PUT", body: { name } });
      if (!result.ok) return result;
      return { ok: true, value: { selected: name } };
    },

    /**
     * 把订阅节点增量灌进内核。
     *
     * mihomo ≥1.16 的 PATCH /configs 是增量语义：只合并 proxies / proxy-groups。
     * 老版本 Clash 会整体覆盖配置（README「已知限制」写明了），所以这里只在
     * 用户主动点「导入节点」时才调用，不自动跑。
     */
    async apply(patch) {
      const payload = { proxies: patch.proxies, "proxy-groups": patch.proxyGroups };
      const result = await call("/configs?force=true", { method: "PATCH", body: payload, timeout: 15000 });
      if (!result.ok) return result;
      return { ok: true, value: { count: patch.proxies.length, group } };
    },
  };
}

/** 把 127.0.0.1:9090 / http://127.0.0.1:9090/ 这类写法归一成 base URL。 */
export function normalizeBase(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { ok: false, code: "no-base", message: "未填写内核 API 地址（例如 http://127.0.0.1:9090）" };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : "http://" + text;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, code: "bad-base", message: "内核 API 地址无法解析：" + text };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "bad-base", message: "仅支持 http/https，收到 " + parsed.protocol };
  }
  // 内核 API 是控制面：只允许回环，避免把订阅密钥发到别处
  const host = parsed.hostname.toLowerCase();
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    return { ok: false, code: "bad-base", message: "内核 API 只允许本机地址（127.0.0.1 / localhost）" };
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return { ok: true, url: parsed.protocol + "//" + parsed.host + path };
}
