/**
 * dsh-model-proxy — 全局 dispatcher 安装 / 热更新 / 释放
 *
 * 为什么必须动全局 dispatcher：
 * DSH 的 LLM adapter（pi-ai 栈）内部用 globalThis.fetch，没有任何 per-request
 * dispatcher 或 fetch 注入点（详见 providers.js 顶部说明）。globalThis.fetch
 * 解析的是 undici 的全局 dispatcher，所以这是唯一的介入点。
 *
 * 为什么不用宿主的 dsh-http-proxy：
 * 它只导出 installProxyFromEnvironment(env, report)，策略**只**从环境变量读，
 * 不接受调用方给的 per-URL 决策函数，也没有导出 ProxyPolicy 类型。
 * 我们要的是「按 origin 列表分流」，公开 API 表达不了，所以自建
 * new Agent({factory})——与宿主 createPolicyDispatcher 同构，只是 factory 换成我们的判定。
 *
 * 关键不变式（源码层已确认）：
 * 把 new Agent(...) 作为 dispatcher 选项传给 fetch/request，会**覆盖**全局 dispatcher
 * 从而静默绕开代理。所以这里只 setGlobalDispatcher，永不传 dispatcher 选项。
 *
 * 代理失败自动降级（FAILOVER）：
 * 命中的域名先走代理；一旦判定代理不通（连不上 / 建隧道超时），本次请求**改直连重发一次**，
 * 并让代理进入冷却期（期间命中域名直接直连，不再反复试代理）。冷却结束后只放**一个**
 * 请求去试探：通了回到代理，没通继续直连并加倍冷却。见 createProxyHealth。
 */

import { createDecider, normalizeProxyUrl, normalizeTargets } from "./policy.js";

/**
 * 关闭旧 agent 的等待上限。
 * agent.close() 是优雅关闭：还有 in-flight 请求、或 keep-alive 连接挂在一个
 * 已经不通的代理上时会一直等下去，把热更新和插件卸载一起拖住。超了就直接 destroy。
 */
const CLOSE_TIMEOUT_MS = 2000;

/**
 * 降级阈值。全部集中在这里，README「代理不通时自动直连」一节与之一一对应。
 *
 * - attemptTimeoutMs：从发出请求到**连接建立**（handler 的 onConnect）的上限。
 *   超过它说明连代理这一段就没走通，此时目标一个字节都没收到，可安全改直连。
 *   只卡「未建立连接」阶段、不卡响应，所以不会误伤 LLM 的长思考 / 长流式响应。
 * - connectTimeoutMs：TCP 连到代理本身的上限（undici connect.timeout），
 *   比 undici 默认的 10s 短，代理没开时能立刻失败。
 * - cooldownMs / maxCooldownMs：判定失败后的直连保持时长，连续失败按 2 倍退避，
 *   封顶 5 分钟 —— 既不会每条请求都撞一次坏代理，也不会在代理恢复后长时间不回来。
 */
export const FAILOVER = Object.freeze({
  attemptTimeoutMs: 5000,
  connectTimeoutMs: 3000,
  cooldownMs: 15000,
  maxCooldownMs: 300000,
  logLimit: 20,
});

/**
 * 连接阶段就失败的 errno 白名单。
 *
 * 进这个集合的前提是**连接都没建立**（handler 没收到 onConnect、也没收到响应头），
 * 也就是请求体一个字节都没发出去 —— 重发不可能让目标执行两次，所以 POST 也能安全重试。
 * ECONNRESET / UND_ERR_SOCKET 只在「还没连上」时才算数：连上以后的断流可能已经送到对端，
 * 那种情况一律不重试（见 #attempt 里的 delivered 判定）。
 */
const PRE_DELIVERY_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * 代理可用性状态机（所有 origin 共用一份）。
 *
 * 状态只有两个：up（照常走代理）/ down（直连，冷却中）。
 * 之所以不引入第三个 half-open 状态：冷却到期后的「试探」直接复用**下一个真实请求**
 * （先当代理可用、失败就降级重发），既不多发探测包，也不需要额外定时器 ——
 * 试探失败对调用方依然无感。
 *
 * @param {object} [options]
 * @param {(event: object) => void} [options.onEvent] 每次状态变化 / 降级时回调，用于日志与状态查询
 * @param {number} [options.cooldownMs] 首次失败后的直连时长
 * @param {number} [options.maxCooldownMs] 退避上限
 * @param {() => number} [options.now] 时钟，测试可注入
 * @returns {object}
 */
export function createProxyHealth({
  onEvent,
  cooldownMs = FAILOVER.cooldownMs,
  maxCooldownMs = FAILOVER.maxCooldownMs,
  now = () => Date.now(),
} = {}) {
  let state = "up";
  let failures = 0;
  let downUntil = 0;
  let probeInFlight = false;
  let lastError = null;
  let retries = 0;
  let directRouted = 0;
  const events = [];

  const record = (event) => {
    const entry = { at: new Date(now()).toISOString(), ...event };
    events.push(entry);
    while (events.length > FAILOVER.logLimit) events.shift();
    try {
      onEvent?.(entry);
    } catch {
      // 日志回调抛错不能影响路由
    }
    return entry;
  };

  const nextCooldown = () => Math.min(cooldownMs * 2 ** Math.max(failures - 1, 0), maxCooldownMs);

  return {
    /** 最近若干条状态变化（环形缓冲，最新在末尾）。 */
    get events() {
      return events.slice();
    },
    /** 给设置卡片 / 诊断用的快照。阈值一并回传，界面不用再抄一份常量。 */
    get snapshot() {
      const remaining = state === "down" ? Math.max(downUntil - now(), 0) : 0;
      return {
        state,
        failures,
        lastError,
        probeInFlight,
        directRemainingMs: remaining,
        nextCooldownMs: state === "down" ? nextCooldown() : cooldownMs,
        retries,
        directRouted,
        thresholds: {
          attemptTimeoutMs: FAILOVER.attemptTimeoutMs,
          connectTimeoutMs: FAILOVER.connectTimeoutMs,
          cooldownMs,
          maxCooldownMs,
        },
        events: events.slice(),
      };
    },

    /**
     * 这条请求该不该先试代理？
     * 冷却中且还没到期 → false（直连，不碰代理，避免反复撞坏代理）。
     * 冷却到期 → 只放**一个**请求去试探（probeInFlight 去重），其余继续直连。
     */
    tryProxy() {
      if (state === "up") return true;
      if (now() >= downUntil && probeInFlight === false) {
        probeInFlight = true;
        return true;
      }
      directRouted += 1;
      return false;
    },

    /** 代理链路真的交付了响应头：代理是好的，退出降级。 */
    succeeded(origin) {
      const wasDown = state === "down" || probeInFlight;
      state = "up";
      failures = 0;
      downUntil = 0;
      probeInFlight = false;
      lastError = null;
      if (wasDown) record({ type: "recovered", url: origin, message: "代理恢复，路由回到代理：" + origin });
    },

    /** 判定代理不通（只在「请求还没送出去」的阶段调用）。 */
    failed({ origin, code, timedOut } = {}) {
      failures += 1;
      const wait = nextCooldown();
      state = "down";
      downUntil = now() + wait;
      probeInFlight = false;
      lastError = code ?? "unknown";
      record({
        type: "proxy-failed",
        url: origin,
        code: lastError,
        timedOut: timedOut === true,
        cooldownMs: wait,
        message: timedOut
          ? "代理 " + Math.round(FAILOVER.attemptTimeoutMs / 1000) + "s 内没建立连接，判定不可用；接下来 " + Math.round(wait / 1000) + "s 直连"
          : "代理连接失败（" + lastError + "），判定不可用；接下来 " + Math.round(wait / 1000) + "s 直连",
      });
      return wait;
    },

    /** 本次请求已改走直连重发。 */
    fallback(origin) {
      retries += 1;
      record({ type: "fallback", url: origin, message: "本次请求改走直连重发：" + origin });
    },
  };
}

/** 当前生效安装的健康状态，供设置卡片查询；未安装时为 null。 */
let activeHealth = null;

/** 取当前生效安装的健康状态（含 thresholds / 最近事件）；未安装返回 null。 */
export function getProxyHealth() {
  return activeHealth;
}

/** 把任意 throw 出来的东西取成一行原因。 */
function messageOf(error) {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

/**
 * 把错误交回给调用方。
 * 两套 handler API 的错误回调签名不同：旧 API 是 onError(err)，
 * 新 API 是 onResponseError(controller, err)。这里按存在性分派。
 */
function forwardError(handler, error) {
  if (typeof handler.onError === "function") return handler.onError(error);
  if (typeof handler.onResponseError === "function") {
    return handler.onResponseError({ aborted: false, abort() {}, pause() {}, resume() {} }, error);
  }
  throw error;
}

/**
 * 安装（或替换）全局 dispatcher，并挂上「代理失败自动直连」。
 *
 * @param {object} options
 * @param {string} options.proxyUrl 已归一化的代理地址，如 http://127.0.0.1:2080
 * @param {(url: URL|string) => boolean} options.decide 判定函数，true = 走代理
 * @param {(event: {url: string, proxied: boolean}) => void} [options.onDecision] 判定回调，用于日志与「测试」功能
 * @param {(event: object) => void} [options.onFailover] 降级事件回调（判定失败 / 改直连 / 恢复）
 * @param {object} [options.health] 注入的健康状态（测试用；缺省新建一份）
 * @param {number} [options.attemptTimeoutMs] 覆盖「建立连接」上限（测试用）
 * @returns {Promise<() => Promise<void>>} disposer，恢复旧 dispatcher 并关闭 agent
 */
export async function installProxyDispatcher({
  proxyUrl,
  decide,
  onDecision,
  onFailover,
  health,
  attemptTimeoutMs = FAILOVER.attemptTimeoutMs,
}) {
  const undici = await import("undici");
  const previous = undici.getGlobalDispatcher();
  const proxyHealth = health ?? createProxyHealth({ onEvent: onFailover });
  const connect = { timeout: FAILOVER.connectTimeoutMs };

  /**
   * 每个 origin 一个实例：同时握住「代理线路」和「直连线路」两条 dispatcher。
   * 切线路只换 dispatch 目标，请求本身（opts / handler）原样复用 —— 这就是
   * 「业务调用方无感知」的落点：它只看到一次正常的 fetch。
   */
  class Router extends undici.Dispatcher {
    #proxy;
    #direct;
    #origin;

    constructor(origin, options) {
      super();
      this.#origin = String(origin);
      // connect 超时必须压到代理客户端上：ProxyAgent 自己只用它来建隧道，
      // 连代理那一段用的是 clientFactory 造出来的 Client（默认 10s）。
      this.#proxy = new undici.ProxyAgent({
        ...options,
        uri: proxyUrl,
        clientFactory: (origin, opts) => new undici.Client(origin, { ...opts, connect }),
      });
      this.#direct = new undici.Pool(origin, options);
    }

    dispatch(opts, handler) {
      if (!proxyHealth.tryProxy()) {
        // 冷却中：直接走直连，连代理的 socket 都不建
        return this.#direct.dispatch(opts, handler);
      }
      return this.#attempt(opts, handler, true);
    }

    /**
     * 一次「先代理」的尝试。
     *
     * 交付判定：handler 收到 onConnect（连接建立）或 onHeaders（响应头）就算**已经交付**，
     * 此后的失败一律原样上报、不重试 —— 那时请求体可能已经送到对端，重发就是重复执行。
     */
    #attempt(opts, handler, allowRetry) {
      const seen = { connected: false, headers: false, settled: false, timedOut: false };
      const controller = new AbortController();
      const outer = opts.signal;
      const forwardAbort = () => {
        try {
          controller.abort(outer?.reason);
        } catch {
          // 已经 abort 过：忽略
        }
      };
      if (outer !== undefined && outer !== null) {
        if (outer.aborted === true) forwardAbort();
        else outer.addEventListener?.("abort", forwardAbort, { once: true });
      }

      const timer = setTimeout(() => {
        if (seen.connected || seen.settled) return;
        seen.timedOut = true;
        try {
          controller.abort(new Error("model-proxy: proxy attempt timeout"));
        } catch {
          // 忽略
        }
        // abort 未必能把卡在建连阶段的请求叫醒（实测 undici 7.29 对未建立连接
        // 的 abort 不总是回调 onError），所以这里自己判定失败、直接改直连，
        // 不等底层报错。onFail 有 settled 兜底，迟到的错误不会二次触发。
        onFail(Object.assign(new Error("model-proxy: 代理建连超时"), { code: "UND_ERR_CONNECT_TIMEOUT" }));
      }, attemptTimeoutMs);
      timer.unref?.();

      const cleanup = () => {
        clearTimeout(timer);
        outer?.removeEventListener?.("abort", forwardAbort);
      };

      const onFail = (err) => {
        if (seen.settled) return true; // 已经换过线路 / 已交付，迟到事件直接丢弃
        seen.settled = true;
        cleanup();
        const code = err?.code ?? err?.cause?.code;
        const delivered = seen.connected || seen.headers;
        const retryable = allowRetry && !delivered && (seen.timedOut || PRE_DELIVERY_CODES.has(code));
        if (!retryable) return forwardError(handler, err);

        proxyHealth.failed({ origin: this.#origin, code: seen.timedOut ? "timeout" : code, timedOut: seen.timedOut });
        proxyHealth.fallback(this.#origin);
        // 放到微任务里重发：此刻第一次 dispatch 的内部清理还没跑完，
        // 同步重入会让同一个 handler 被两次 dispatch 交叉回调（实测会挂住）。
        queueMicrotask(() => {
          try {
            this.#direct.dispatch(opts, handler);
          } catch (error) {
            forwardError(handler, error);
          }
        });
        return true;
      };

      const wrapped = Object.create(handler);
      if (typeof handler.onRequestStart === "function") {
        // 新 handler API（DispatcherHandler）：onRequestStart 约等于连接建立
        wrapped.onRequestStart = (ctrl, ctx) => {
          seen.connected = true;
          return handler.onRequestStart?.(ctrl, ctx);
        };
        wrapped.onResponseStart = (ctrl, status, headers, msg) => {
          seen.headers = true;
          cleanup();
          proxyHealth.succeeded(this.#origin);
          return handler.onResponseStart?.(ctrl, status, headers, msg);
        };
        wrapped.onResponseError = (ctrl, err) => onFail(err);
      } else {
        // 旧 handler API（fetch / request 都走这条）
        wrapped.onConnect = (abort, ctx) => {
          seen.connected = true;
          return handler.onConnect?.(abort, ctx);
        };
        wrapped.onHeaders = (status, headers, resume, msg) => {
          seen.headers = true;
          cleanup();
          proxyHealth.succeeded(this.#origin);
          return handler.onHeaders?.(status, headers, resume, msg);
        };
        wrapped.onError = (err) => onFail(err);
      }

      try {
        return this.#proxy.dispatch({ ...opts, signal: controller.signal }, wrapped);
      } catch (error) {
        return onFail(error);
      }
    }

    close() {
      return Promise.all([this.#proxy.close().catch(() => {}), this.#direct.close().catch(() => {})]).then(
        () => undefined,
      );
    }

    destroy(error) {
      try {
        this.#proxy.destroy(error);
      } catch {
        // 忽略
      }
      return this.#direct.destroy(error);
    }
  }

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
      // Router 内部按健康状态选 ProxyAgent / Pool，并在代理不通时自动改直连
      return new Router(origin, options);
    }
    return new undici.Pool(origin, options);
  };

  const agent = new undici.Agent({ factory });
  try {
    undici.setGlobalDispatcher(agent);
  } catch (error) {
    // 建出来了却没装上，必须自己关掉：agent 带连接池，漏在这儿没人回收
    await agent.close().catch(() => {});
    throw error;
  }
  activeHealth = proxyHealth;

  return async () => {
    if (activeHealth === proxyHealth) activeHealth = null;
    // 全局 dispatcher 是所有插件共享的单例：只有它还是我们装的那个时才恢复，
    // 否则会把别的插件后来装的 dispatcher 一起覆盖掉。
    if (undici.getGlobalDispatcher() === agent) undici.setGlobalDispatcher(previous);
    let timer;
    const closed = await Promise.race([
      agent.close().then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), CLOSE_TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (closed) return;
    // 关不掉就硬拆：宁可丢几个 in-flight 连接，也不要卡住卸载 / 热更新
    try {
      if (typeof agent.destroy === "function") agent.destroy();
    } catch {}
  };
}

/**
 * 保持一个「当前生效的安装」的引用，供配置热更新时替换。
 * 单实例插件不需要叠加多个安装。
 */
let activeDispose = null;

/**
 * 换装是「先拆后装」两段异步：并发调用时两个都看到 activeDispose === null，
 * 于是都装、谁都不拆，先装的那个 agent 的 keep-alive 连接池就再没人关，
 * 全局 dispatcher 也取决于谁后完成。设置卡片每敲一下地址就可能触发一次 sync，
 * 所以这里把安装/卸载串成一条链，按调用顺序一件一件做完。
 */
let transition = Promise.resolve();

/** @template T @param {() => Promise<T>} task @returns {Promise<T>} */
function serialize(task) {
  const run = transition.then(task);
  transition = run.catch(() => {});
  return run;
}

/**
 * 真正拆的那半，不排队 —— 只能在 serialize 的任务体里调用，
 * 否则 disposeProxyPlan 会等自己，直接死锁。
 */
async function disposeActive() {
  const dispose = activeDispose;
  activeDispose = null;
  if (typeof dispose !== "function") return;
  try {
    await dispose();
  } catch {
    // 关闭失败不阻断后续安装
  }
}

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
 * @param {(event: object) => void} [options.onFailover] 降级事件（判定失败 / 改直连 / 恢复）
 * @param {object} [options.health] 注入健康状态（测试用）
 * @param {number} [options.attemptTimeoutMs] 覆盖建连超时（测试用）
 * @param {boolean} [options.enabled] 代理总开关，关掉时不碰 dispatcher
 * @returns {Promise<{active: boolean, reason?: string}>}
 */
export function applyProxyPlan(plan, { onDecision, onFailover, health, attemptTimeoutMs, enabled = true } = {}) {
  return serialize(async () => {
    await disposeActive();
    if (enabled === false) return { active: false, reason: "插件已禁用" };
    if (plan === null || plan === undefined) return { active: false, reason: "未配置代理" };

    const normalized = normalizeProxyUrl(plan.proxyUrl ?? "");
    if (!normalized.ok) return { active: false, reason: normalized.reason };
    const decide = plan.decide;
    if (typeof decide !== "function") return { active: false, reason: "缺少路由判定器" };

    let dispose;
    try {
      dispose = await installProxyDispatcher({
        proxyUrl: normalized.url,
        decide,
        onDecision,
        onFailover,
        health,
        ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
      });
    } catch (error) {
      // 不能往外抛：这一步之前旧安装已经被拆掉，抛出去会让调用方停在上一版状态
      // （界面还可能显示「已生效」），而实际出口早已恢复直连。
      return { active: false, reason: "安装全局代理失败：" + messageOf(error) };
    }
    activeDispose = dispose;
    return { active: true };
  });
}

/**
 * 卸载当前安装（恢复宿主原 dispatcher）。
 *
 * @returns {Promise<void>}
 */
export function disposeProxyPlan() {
  return serialize(() => disposeActive());
}

/**
 * 由配置拼出「路由计划」：归一化勾选项 → 判定器 → 代理地址。
 * 纯计算，不碰 dispatcher，便于单测与界面预览。
 *
 * @param {object} input
 * @param {string} input.mode off | allowlist | everything
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

export { createDecider, normalizeProxyUrl, normalizeTargets };
