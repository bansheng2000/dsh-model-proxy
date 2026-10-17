/**
 * dsh-model-proxy — 主入口
 *
 * 需求（用户 m01580 后的修正）：
 *   「加域名走本地网络代理」
 * 即：填一批域名，这些域名的出站走 NekoBox 之类的本地 HTTP 代理，其余直连。
 * 早期版本做的是「勾选哪些模型 / 供应商走代理」，但供应商粒度对本机环境意义不大
 * （本机只有 deepseek-official / deepseek-account / opencode2dsh 三个，其中
 *  opencode2dsh 是 loopback sidecar 天然直连），所以主交互改成填域名。
 * 供应商解析仍然保留——它只是「帮你把 provider id 翻译成域名」的便利功能。
 *
 * 实现路径的硬约束（已在宿主源码/契约中确认）：
 *   DSH 的 `llm` 服务没有 per-request dispatcher 或 fetch 注入点，adapter 自己用
 *   `globalThis.fetch` 发请求；`agent/request` 可改写的 `LlmCallConfig` 里没有 baseURL。
 *   → 唯一可编程点是 undici 的全局 dispatcher，而它只按 origin（host:port）决策。
 *   → 所以「填域名」直接映射成「这些 origin 走代理」；同时保留供应商→域名的自动
 *     翻译（同为传输层限制：同一 host 上的其他请求会一并被代理，界面显式提示）。
 *
 * 安全的默认值：插件默认 `enabled: false` 且 `mode: off`，装上后不改变任何现有行为，
 * 用户必须显式填代理地址并勾选才会接管出站。
 */

import z from "@deepseek-ai/schemastery";

import { applyProxyPlan, disposeProxyPlan, planFromConfig } from "./dispatcher.js";
import { makeBridgeRoutes } from "./bridge.js";
import { createHostResolver, KNOWN_PROVIDER_HOSTS } from "./providers.js";
import { normalizeProxyUrl, POLICY_MODES, probeTargetVerdict } from "./policy.js";

/** 命名空间 = Loader 条目 id，必须与 cordis.patch.yml 里的 `- id:` 一致。 */
const MODEL_PROXY_NS = "model-proxy";
/** 探针没带 provider 时，实测 host 落到这个键下（不能用空串，见 observedKey）。 */
const UNKNOWN_PROVIDER_KEY = "(manual)";

/**
 * 插件配置 schema。
 *
 * 两个 DSH 0.1.7 的约束决定了这里的形状（见 opencode2dsh 的注释，lib/index.js:1087-1099）：
 *  1. 没有 `ctx.settings.register(ns, schema)`；插件导出 `Config`，dsh-settings 从
 *     Loader 条目 id 推出命名空间。
 *  2. **嵌套 `.volatile()` 是 schemastery 硬错误**，所以整个可编辑面只能是
 *     一个 volatile 节点。本插件把全部可编辑字段收进 `rules` 这一个节点。
 *
 * 字段都标 `.volatile()` 是因为它们要在设置卡片里实时改；这里统一放在 rules 下，
 * 由插件自己的卡片（plugins.row.config）提供交互，schema 只负责校验与默认值。
 * `selected` 现在装的是**域名清单**（一行一个），名字保留是为了不动已有配置。
 */
const Rules = z.object({
  enabled: z.boolean().default(false),
  mode: z.union(POLICY_MODES).default("off"),
  proxyUrl: z.string().default(""),
  selected: z.array(z.string()).default([]),
  bypass: z.array(z.string()).default([]),
});

const Config = z.object({
  rules: Rules.volatile(),
});

/**
 * 展开 Loader 传进来的 volatile 引用。
 * `.volatile()` 字段在运行期是 `Volatile<T>` 包装，`.get()` 才是当前值；
 * 每次读都解一次，保证热更新后立刻看到新值。
 *
 * @param {unknown} config
 * @returns {any}
 */
function resolveConfig(config) {
  if (config === null || typeof config !== "object") return {};
  const plain = {};
  // 先解包：volatile 引用只有 `get` 一个可枚举键，直接 Object.entries 会丢掉它带的值。
  for (const [key, value] of Object.entries(config)) {
    plain[key] = unwrap(value);
  }
  const rulesValue = plain.rules;
  if (rulesValue !== null && typeof rulesValue === "object" && !Array.isArray(rulesValue)) {
    const rules = {};
    for (const [key, value] of Object.entries(rulesValue)) rules[key] = unwrap(value);
    plain.rules = rules;
  }
  return plain;
}

function unwrap(value) {
  return value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

/** 配置默认值，Loader 没给全时兜底。与 cordis.patch.yml 的示例保持一致。 */
const DEFAULTS = Object.freeze({
  enabled: false,
  mode: "off",
  proxyUrl: "",
  // 故意留空：装上插件不代理任何域名，必须用户自己填（见文件头「安全的默认值」）。
  selected: [],
  bypass: [],
});

/**
 * 补齐缺失字段。
 *
 * @param {any} resolved `resolveConfig` 的结果
 * @returns {{enabled: boolean, mode: string, proxyUrl: string, selected: string[], bypass: string[]}}
 */
function rulesOf(resolved) {
  const rules = { ...DEFAULTS, ...(resolved?.rules ?? {}) };
  // selected 可能从 patch 里读成 null（用户删掉了那一行），此时回落默认值
  const selected = Array.isArray(rules.selected)
    ? rules.selected.filter((x) => typeof x === "string")
    : DEFAULTS.selected;
  return {
    enabled: rules.enabled === true,
    mode: POLICY_MODES.includes(rules.mode) ? rules.mode : "off",
    proxyUrl: typeof rules.proxyUrl === "string" ? rules.proxyUrl : "",
    selected,
    bypass: Array.isArray(rules.bypass) ? rules.bypass.filter((x) => typeof x === "string") : [],
  };
}

const name = "model-proxy";
// 只声明真正需要的 seam。不要把 settings 写进 inject —— dsh-settings 自身 inject
// ['configEditor','profileContext']，在缺 profileContext 的组合（CLI/headless）下整个
// seam 不可用，会让 fiber 永不激活，连带代理也失效。用 ctx.inject 懒加载（opencode2dsh :1674-1683）。
const inject = [];

function apply(ctx, config) {
  const logger = ctx.logger;
  const currentRules = () => rulesOf(resolveConfig(config));

  // 运行期状态，供桥查询
  let lastStatus = { active: false, reason: "尚未初始化", mode: "off" };
  // 实测到的 host：provider → origin 列表。由"测试"动作填充。
  const observed = new Map();
  // 「实际影响的域名」只是观测集合：每见一个新 origin 就给每个非 host 目标各加一条，
  // 不封顶的话跑久了内存和界面一起涨。上限内淘汰最早的（先进先出）。
  const MAX_OBSERVED_HOSTS = 50;
  const observe = (key, host) => {
    const list = observed.get(key) ?? [];
    if (list.includes(host)) return;
    list.push(host);
    while (list.length > MAX_OBSERVED_HOSTS) list.shift();
    observed.set(key, list);
  };

  const hostResolver = () =>
    createHostResolver({ observed: Object.fromEntries(observed) });

  /**
   * 按当前配置重建 dispatcher。设置一改就调用。
   */
  const sync = async () => {
    const rules = currentRules();
    if (!rules.enabled) {
      await disposeProxyPlan();
      lastStatus = { active: false, reason: "插件未启用", mode: rules.mode };
      logger.info("model-proxy: disabled, outbound traffic stays direct");
      return lastStatus;
    }
    // 「全部走代理」不需要勾选任何东西——模式本身就是完整指令。
    // 空勾选守卫只对白名单生效，否则 everything + 空勾选会静默不生效
    // （policy.js 的 createDecider 对 everything 是无条件放行的）。
    const needsSelection = rules.mode !== "everything";
    if (rules.mode === "off" || (needsSelection && rules.selected.length === 0)) {
      await disposeProxyPlan();
      lastStatus = {
        active: false,
        reason: needsSelection ? "未填写任何域名，保持直连" : "分流模式为关闭，保持直连",
        mode: rules.mode,
      };
      return lastStatus;
    }
    const normalized = normalizeProxyUrl(rules.proxyUrl);
    if (!normalized.ok) {
      await disposeProxyPlan();
      lastStatus = { active: false, reason: normalized.reason, mode: rules.mode };
      logger.warn(`model-proxy: ${normalized.reason} — outbound traffic stays direct`);
      return lastStatus;
    }

    const knownProvider = (provider) => Object.hasOwn(KNOWN_PROVIDER_HOSTS, provider.toLowerCase());
    const plan = planFromConfig({
      mode: rules.mode,
      selected: rules.selected,
      bypass: rules.bypass,
      hostsForProvider: hostResolver(),
      knownProvider,
      proxyUrl: normalized.url,
    });
    const result = await applyProxyPlan(plan, {
      onDecision: ({ url, proxied }) => {
        // 记住"勾选后实际打到了哪些 origin"，让界面能显示真实影响面
        if (proxied) {
          const host = safeHost(url);
          if (host !== null) {
            for (const item of plan.targets) {
              if (item.kind === "host") continue;
              observe(item.provider, host);
            }
          }
        }
        void url;
      },
    });
    lastStatus = result.active
      ? { active: true, mode: rules.mode, proxyUrl: normalized.url, targets: rules.selected }
      : { active: false, reason: result.reason, mode: rules.mode };
    logger[result.active ? "info" : "warn"](
      result.active
        ? `model-proxy: active — ${plan.targets.length} rule(s) via ${normalized.url}`
        : `model-proxy: inactive — ${result.reason}`,
    );
    return lastStatus;
  };

  // 探针记 host 时的 key。payload 里没带 provider 就不能用空串：桥会返回
  // {"observed":{"":["host",...]}}，那是无意义数据，而且会打挂部分 JSON 解析器
  // （PowerShell 5.1 的 ConvertFrom-Json 见到空键直接抛 "参数 name 的值无效"，
  // 整页读不到数据）。没 provider 就落到固定的占位键上。
  const observedKey = (payload) => {
    const provider = String(payload?.provider ?? "").trim().toLowerCase();
    return provider === "" ? UNKNOWN_PROVIDER_KEY : provider;
  };

  // ── 探针：证明代理真的在监听、并记录真实 origin ────────────────────────────
  // 同一时刻只允许一个探测：探针是本机 HTTP 客户端，能被并发反复调用的话就成了
  // 廉价的端口扫描器（顺带还会把 observed 撑大）。
  let probeBusy = false;
  const probe = async (payload) => {
    const url = typeof payload?.url === "string" ? payload.url : "";
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: `无法解析地址：${url}` };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, message: `不支持的协议 ${parsed.protocol}` };
    }
    // 只放行「用户已经列进 selected 的公网域名」，回环与内网一律拒。
    // 不设限时探针能按状态码/耗时把 127.0.0.1 的端口挨个扫出来（审查实测过）。
    const verdict = probeTargetVerdict(parsed, currentRules());
    if (!verdict.ok) return { ok: false, code: "probe-rejected", message: verdict.reason };
    if (probeBusy) return { ok: false, code: "probe-busy", message: "已有探测在进行，稍后再试" };
    probeBusy = true;
    try {
      // 直接探测代理本身：用 TCP 连一下，比发 HTTP 更容易失败且更快
      const proxyCheck = await checkProxyReachable(currentRules().proxyUrl);
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        // 走一个必然 404/401 的路径，只为确认链路通不通；不携带任何凭据
        const response = await fetch(parsed.toString(), { method: "HEAD", signal: controller.signal, redirect: "manual" });
        clearTimeout(timer);
        const host = parsed.port === "" ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
        observe(observedKey(payload), host);
        return {
          ok: true,
          status: response.status,
          elapsedMs: Date.now() - started,
          host,
          proxyReachable: proxyCheck.reachable,
          proxyError: proxyCheck.error,
        };
      } catch (error) {
        return {
          ok: false,
          elapsedMs: Date.now() - started,
          message: messageOf(error),
          proxyReachable: proxyCheck.reachable,
          proxyError: proxyCheck.error,
        };
      }
    } finally {
      probeBusy = false;
    }
  };

  // 启动即生效一次
  void sync().catch((error) => {
    logger.error(`model-proxy: initial sync failed: ${messageOf(error)}`);
  });

  // ── settings：声明自有设置卡片 + 跟随变更热更新 ───────────────────────────
  ctx.inject(["settings"], (sctx) => {
    // auto:false —— 插件自带卡片，不让宿主再生成一份 schema 表单
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber));
    // 设置一改立刻重建 dispatcher，无需重启 DSH
    sctx.on("settings/document-updated", (changedNs) => {
      if (String(changedNs) !== MODEL_PROXY_NS) return;
      void sync().catch((error) => {
        logger.error(`model-proxy: resync failed: ${messageOf(error)}`);
      });
    });
  });

  // ── webServer：把桥挂出去，供前端卡片读写 ────────────────────────────────
  // llm 不能写进 inject：它是可选 seam，硬性依赖会让缺 llm 的组合整个 fiber 永不
  // 激活，卡片直接 401 消失（opencode2dsh :1674-1683 的教训）。改成运行时 sctx.get
  // 懒取——桥照常挂载，只是那一次请求的 provider 列表为空。
  ctx.inject(["webServer", "settings"], (sctx) => {
    sctx.effect(() => {
      const routes = makeBridgeRoutes({
        settings: sctx.settings,
        ns: MODEL_PROXY_NS,
        getStatus: async () => lastStatus,
        getConfig: () => currentRules(),
        listProviders: async () => {
          const llm = sctx.get("llm");
          if (llm === undefined) return [];
          try {
            // listProviders() 返回 LlmProviderInfo[]（{id,name}），不是字符串数组。
            return llm.listProviders();
          } catch {
            return [];
          }
        },
        getObserved: async () => Object.fromEntries(observed),
        probe,
      }).map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of routes) dispose();
      };
    }, "model-proxy: settings bridge");
  });

  // 插件被禁用/卸载时必须把全局 dispatcher 还原，否则整台 DSH 会永久走代理
  ctx.on("dispose", () => {
    void disposeProxyPlan();
  });
}

function safeHost(origin) {
  try {
    const url = new URL(String(origin));
    return url.port === "" ? url.hostname.toLowerCase() : `${url.hostname.toLowerCase()}:${url.port}`;
  } catch {
    return null;
  }
}

/**
 * 探一下代理端口在不在监听。
 * 只做 TCP 连接，不发数据；失败通常意味着 NekoBox 没开或端口填错。
 *
 * @param {string} rawProxyUrl
 * @returns {Promise<{reachable: boolean, error?: string}>}
 */
async function checkProxyReachable(rawProxyUrl) {
  const normalized = normalizeProxyUrl(rawProxyUrl);
  if (!normalized.ok) return { reachable: false, error: normalized.reason };
  let url;
  try {
    url = new URL(normalized.url);
  } catch {
    return { reachable: false, error: "代理地址无法解析" };
  }
  const net = await import("node:net");
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port });
    const done = (reachable, error) => {
      socket.destroy();
      resolve(error === undefined ? { reachable } : { reachable, error });
    };
    socket.setTimeout(3000, () => done(false, `连接 ${url.hostname}:${port} 超时`));
    socket.once("connect", () => done(true));
    socket.once("error", (error) => done(false, error.message));
  });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

export { MODEL_PROXY_NS, Config, Rules, apply, inject, name, rulesOf, resolveConfig };
export default { apply, inject, name, Config };