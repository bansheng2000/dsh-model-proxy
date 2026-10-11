/**
 * dsh-model-proxy — 全局 dispatcher 安装 / 热更新 / 释放
 *
 * 为什么必须动全局 dispatcher：
 * DSH 的 LLM adapter（pi-ai 栈）内部用 `globalThis.fetch`，没有任何 per-request
 * dispatcher 或 fetch 注入点（详见 providers.js 顶部说明）。`globalThis.fetch`
 * 解析的是 undici 的全局 dispatcher，所以这是唯一的介入点。
 *
 * 为什么不用宿主的 `dsh-http-proxy`：
 * 它只导出 `installProxyFromEnvironment(env, report)`，策略**只**从环境变量读，
 * 不接受调用方给的 per-URL 决策函数，也没有导出 `ProxyPolicy` 类型。
 * 我们要的是「按 origin 列表分流」，公开 API 表达不了，所以自建
 * `new Agent({factory})`——与宿主 `createPolicyDispatcher` 同构，只是 factory 换成我们的判定。
 *
 * 关键不变式（源码层已确认）：
 * 把 `new Agent(...)` 作为 `dispatcher` 选项传给 fetch/request，会**覆盖**全局 dispatcher
 * 从而静默绕开代理。所以这里只 `setGlobalDispatcher`，永不传 dispatcher 选项。
 */

import { createDecider, normalizeProxyUrl, normalizeTargets } from "./policy.js";

/**
 * 安装（或替换）全局 dispatcher。
 *
 * @param {object} options
 * @param {string} options.proxyUrl 已归一化的代理地址，如 `http://127.0.0.1:2080`
 * @param {(url: URL|string) => boolean} options.decide 判定函数，true = 走代理
 * @param {(event: {url: string, proxied: boolean}) => void} [options.onDecision] 判定回调，用于日志与「测试」功能
 * @returns {Promise<() => Promise<void>>} disposer，恢复旧 dispatcher 并关闭 agent
 */
export async function installProxyDispatcher({ proxyUrl, decide, onDecision }) {
  const undici = await import("undici");
  const previous = undici.getGlobalDispatcher();

  const factory = (origin, options) => {
    const proxied = decide(origin);
    if (onDecision !== undefined) {
      try {
        onDecision({ url: String(origin), proxied });
      } catch {
        // 日志回调抛错不能影响路由
      }
    }
    if (proxied) {
      // ProxyAgent 走 CONNECT 到代理，TLS 由对端与客户端之间端到端完成
      return new undici.ProxyAgent({ ...options, uri: proxyUrl });
    }
    return new undici.Pool(origin, options);
  };

  const agent = new undici.Agent({ factory });
  undici.setGlobalDispatcher(agent);

  return async () => {
    undici.setGlobalDispatcher(previous);
    await agent.close();
  };
}

/**
 * 保持一个「当前生效的安装」的引用，供配置热更新时替换。
 * 单实例插件不需要叠加多个安装。
 */
let activeDispose = null;

/**
 * 按当前配置安装 / 更新 / 卸载全局代理。
 * - 配置无效（地址解析不出、模式 off、无勾选）→ 卸载并恢复直连
 * - 配置有效 → 卸载旧的再装新的，保证热更新不留残余
 *
 * @param {object|null} plan
 * @param {string} [plan.proxyUrl]
 * @param {(url: URL|string) => boolean} [plan.decide]
 * @param {object} [options]
 * @param {(event: {url: string, proxied: boolean}) => void} [options.onDecision]
 * @param {string} [options.enabled] 代理总开关，关掉时不碰 dispatcher
 * @returns {Promise<{active: boolean, reason?: string}>}
 */
export async function applyProxyPlan(plan, { onDecision, enabled = true } = {}) {
  await disposeProxyPlan();
  if (enabled === false) return { active: false, reason: "插件已禁用" };
  if (plan === null || plan === undefined) return { active: false, reason: "未配置代理" };

  const normalized = normalizeProxyUrl(plan.proxyUrl ?? "");
  if (!normalized.ok) return { active: false, reason: normalized.reason };
  const decide = plan.decide;
  if (typeof decide !== "function") return { active: false, reason: "缺少路由判定器" };

  const dispose = await installProxyDispatcher({ proxyUrl: normalized.url, decide, onDecision });
  activeDispose = dispose;
  return { active: true };
}

/**
 * 卸载当前安装（恢复宿主原 dispatcher）。
 *
 * @returns {Promise<void>}
 */
export async function disposeProxyPlan() {
  const dispose = activeDispose;
  activeDispose = null;
  if (dispose === undefined) return;
  try {
    await dispose();
  } catch {
    // 关闭失败不阻断后续安装
  }
}

/**
 * 由配置拼出「路由计划」：归一化勾选项 → 判定器 → 代理地址。
 * 纯计算，不碰 dispatcher，便于单测与界面预览。
 *
 * @param {object} input
 * @param {string} input.mode `off` | `allowlist` | `everything`
 * @param {readonly string[]} input.selected 勾选的 provider / model / host 原始字符串
 * @param {readonly string[]} [input.bypass] 永远直连的 host 模式
 * @param {(provider: string) => readonly string[]} input.hostsForProvider
 * @param {(provider: string) => boolean} [input.knownProvider]
 * @param {string} [input.proxyUrl] 用户填的代理地址（原样，校验交给 applyProxyPlan）
 * @returns {{decide: (url: URL|string) => boolean, targets: object[], proxyUrl: string}}
 */
export function planFromConfig({ mode, selected, bypass, hostsForProvider, knownProvider, proxyUrl = "" }) {
  const targets = normalizeTargets(selected, knownProvider);
  const decide = createDecider({ mode, targets, bypassHosts: bypass ?? [], hostsForProvider });
  return { decide, targets, proxyUrl };
}