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

import os from "node:os";
import path from "node:path";

import z from "@deepseek-ai/schemastery";

import { applyProxyPlan, disposeProxyPlan, getProxyHealth, planFromConfig } from "./dispatcher.js";
import { makeBridgeRoutes } from "./bridge.js";
import { createHostResolver, KNOWN_PROVIDER_HOSTS } from "./providers.js";
import { normalizeProxyUrl, POLICY_MODES, probeTargetVerdict } from "./policy.js";
import { createClashAdapter } from "./core-adapter.js";
import { createNodePool, POOL_DEFAULTS } from "./nodes.js";
import { buildCorePatch, fetchSubscription, parseSubscription } from "./subscription.js";
import { buildConfig, createCoreProcess, installCore, resolveBinary } from "./core-manager.js";

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
  // ── 节点管理（v0.3 起）：订阅地址 / 内核控制面 / 自动切换 ──────────────────
  // 订阅可以是 URL，也可以直接粘内容（含密钥，只存在本机配置里）。
  subscription: z.string().default(""),
  coreApi: z.string().default(""),
  coreSecret: z.string().default(""),
  coreGroup: z.string().default("DSH"),
  nodesAuto: z.boolean().default(false),
  // 代理出口二选一：local = 自己填的本地代理地址，subscription = 插件托管内核 + 订阅节点。
  // 选了 subscription 就等于打开 coreManaged（见 rulesOf，避免两个开关互相打架）。
  proxySource: z.union(["local", "subscription"]).default("local"),
  // ── 托管内核（v0.3.1 起）：插件自己下载并跑 mihomo ────────────────────────
  // A 方案要求用户先装好内核；打开这个开关后插件把内核当子进程管起来，
  // 代理地址与内核 API 地址都自动指向它（下面两个端口）。
  coreManaged: z.boolean().default(false),
  coreDir: z.string().default(""),
  coreVersion: z.string().default(""),
  coreApiPort: z.number().min(1).max(65535).default(9090),
  coreMixedPort: z.number().min(1).max(65535).default(2081),
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

/** 端口兜底：schema 会校验，但从老 patch 读回来的值可能是字符串/null。 */
function portOf(value, fallback) {
  const port = typeof value === "number" ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

/** 配置默认值，Loader 没给全时兜底。与 cordis.patch.yml 的示例保持一致。 */
const DEFAULTS = Object.freeze({
  enabled: false,
  mode: "off",
  proxyUrl: "",
  // 故意留空：装上插件不代理任何域名，必须用户自己填（见文件头「安全的默认值」）。
  selected: [],
  bypass: [],
  subscription: "",
  coreApi: "",
  coreSecret: "",
  coreGroup: "DSH",
  nodesAuto: false,
  proxySource: "local",
  coreManaged: false,
  coreDir: "",
  coreVersion: "",
  coreApiPort: 9090,
  coreMixedPort: 2081,
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
  const text = (value, fallback = "") => (typeof value === "string" ? value : fallback);
  const proxySource = rules.proxySource === "subscription" ? "subscription" : "local";
  return {
    enabled: rules.enabled === true,
    mode: POLICY_MODES.includes(rules.mode) ? rules.mode : "off",
    proxyUrl: typeof rules.proxyUrl === "string" ? rules.proxyUrl : "",
    selected,
    bypass: Array.isArray(rules.bypass) ? rules.bypass.filter((x) => typeof x === "string") : [],
    subscription: text(rules.subscription),
    coreApi: text(rules.coreApi),
    coreSecret: text(rules.coreSecret),
    coreGroup: text(rules.coreGroup, "DSH") === "" ? "DSH" : text(rules.coreGroup, "DSH"),
    nodesAuto: rules.nodesAuto === true,
    proxySource,
    // 订阅代理 = 托管内核，唯一真相是 proxySource；coreManaged 只当派生值用
    coreManaged: proxySource === "subscription" || rules.coreManaged === true,
    coreDir: text(rules.coreDir),
    coreVersion: text(rules.coreVersion),
    coreApiPort: portOf(rules.coreApiPort, DEFAULTS.coreApiPort),
    coreMixedPort: portOf(rules.coreMixedPort, DEFAULTS.coreMixedPort),
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

  // ── 节点管理：订阅 / 测速 / 自动切换 ──────────────────────────────────────
  // 插件不自己跑协议。VLESS / Hysteria2 是传输协议，undici 的 ProxyAgent 说不了；
  // 真正跑节点的是本机内核（mihomo / Clash Verge / sing-box 的 clash_api）。
  // 这里只调内核的 REST API：读节点、让它握手测延迟、切 select 组。
  // 没填内核地址时整块休眠，插件行为与 v0.2.x 完全一致。
  const NODE_TEST_URL = "https://www.gstatic.com/generate_204";
  const adapterNow = () => {
    const rules = currentRules();
    return createClashAdapter({ baseUrl: coreApiNow(), secret: rules.coreSecret, group: rules.coreGroup });
  };
  let pool = null;
  const poolNow = () => {
    if (pool === null) {
      pool = createNodePool({
        // 闭包延迟取值：设置里改了内核地址/组名，下一次调用就跟上，不用重建池
        adapter: {
          delay: (name, options) => adapterNow().delay(name, { url: NODE_TEST_URL, ...options }),
          select: (name) => adapterNow().select(name),
        },
        log: (line) => logger.info("model-proxy: " + line),
      });
    }
    return pool;
  };

  // ── 托管内核（B 方案）：插件自己下载 / 启动 mihomo ────────────────────────
  // A 方案要求用户先装好内核（Clash Verge / NekoBox 之类）。B 让插件把内核当子进程
  // 管起来：代理地址、内核 API 地址都指向它，节点池/测速/自动切换逻辑一行不动。
  const coreDirNow = () => {
    const custom = currentRules().coreDir.trim();
    return custom === "" ? path.join(os.homedir(), ".dsh", "dsh-model-proxy-core") : custom;
  };
  /** 内核控制面地址：托管时固定指向自己起的那个内核。 */
  const coreApiNow = () => {
    const rules = currentRules();
    return rules.coreManaged ? `http://127.0.0.1:${rules.coreApiPort}` : rules.coreApi;
  };
  /** 出站代理地址：托管时指向自己的 mixed 端口，用户填的 proxyUrl 不再参与。 */
  const coreProxyUrl = () => {
    const rules = currentRules();
    return rules.coreManaged ? `http://127.0.0.1:${rules.coreMixedPort}` : rules.proxyUrl;
  };

  // 订阅解析出来的节点：托管内核的配置从这里来（A 方案是灌进别人的内核）。
  let subscriptionNodes = [];
  let coreProc = null;
  let coreKey = "";
  const coreConfigNow = () => {
    const rules = currentRules();
    const patch = buildCorePatch(subscriptionNodes, { group: rules.coreGroup });
    return buildConfig({
      proxies: patch.proxies,
      proxyGroups: patch.proxyGroups,
      group: rules.coreGroup,
      mixedPort: rules.coreMixedPort,
      apiPort: rules.coreApiPort,
      secret: rules.coreSecret,
    });
  };
  const coreNow = () => {
    const rules = currentRules();
    const dir = coreDirNow();
    const key = `${dir}|${rules.coreApiPort}|${rules.coreMixedPort}|${rules.coreSecret}`;
    if (coreProc === null || coreKey !== key) {
      coreProc = createCoreProcess({
        dir,
        binPath: resolveBinary({ dir }).path,
        config: coreConfigNow(),
        apiPort: rules.coreApiPort,
        mixedPort: rules.coreMixedPort,
        secret: rules.coreSecret,
        log: (line) => logger.info("model-proxy: " + line),
      });
      coreKey = key;
    }
    return coreProc;
  };

  const coreStatus = () => {
    const rules = currentRules();
    const dir = coreDirNow();
    const bin = resolveBinary({ dir });
    return {
      managed: rules.coreManaged,
      dir,
      binary: { ok: bin.ok, path: bin.path, source: bin.source, error: bin.error },
      api: `http://127.0.0.1:${rules.coreApiPort}`,
      proxy: `http://127.0.0.1:${rules.coreMixedPort}`,
      nodes: subscriptionNodes.length,
      process: coreProc === null ? null : coreProc.snapshot(),
    };
  };

  /** 下载内核（走全局 fetch → 受本插件分流管辖）。 */
  const coreInstall = async () => {
    const rules = currentRules();
    const installed = await installCore({
      dir: coreDirNow(),
      version: rules.coreVersion.trim(),
      log: (line) => logger.info("model-proxy: " + line),
    });
    if (!installed.ok) return { ok: false, code: "core-install-failed", message: installed.error };
    // 换了内核就得按新路径重建进程对象
    coreKey = "";
    return { ok: true, value: { ...installed } };
  };

  const coreStart = async () => {
    if (!currentRules().coreManaged) {
      return { ok: false, code: "core-not-managed", message: "先在设置里打开「由插件托管内核」" };
    }
    if (!resolveBinary({ dir: coreDirNow() }).ok) {
      return { ok: false, code: "core-missing", message: "托管目录里还没有内核，先点「安装内核」" };
    }
    const proc = coreNow();
    const started = await proc.start(coreConfigNow());
    if (!started.ok) return { ok: false, code: "core-start-failed", message: started.error };
    return { ok: true, value: proc.snapshot() };
  };

  const coreStop = async () => {
    if (coreProc === null) return { ok: true, value: null };
    await coreProc.stop();
    return { ok: true, value: coreProc.snapshot() };
  };

    /** 从内核读当前节点清单（不刷新订阅，纯只读）。 */
  const listNodes = async () => {
    const rules = currentRules();
    if (coreApiNow().trim() === "") return { ok: false, code: "no-core", message: "未填写内核 API 地址（例如 http://127.0.0.1:9090）" };
    const listed = await adapterNow().list();
    if (!listed.ok) return { ok: false, code: listed.code, message: listed.message };
    const target = poolNow();
    target.setNodes(listed.value.nodes);
    target.setCurrent(listed.value.current);
    return { ok: true, value: target.snapshot() };
  };

  /**
   * 拉订阅 → 解析 → 灌内核 → 回读节点。
   * 订阅内容可以是 URL，也可以直接粘文本（机场常给一整段 base64）。
   */
  const refreshSubscription = async () => {
    const rules = currentRules();
    const source = rules.subscription.trim();
    if (source === "") return { ok: false, code: "no-subscription", message: "未填写订阅地址或内容" };
    let text = source;
    if (/^https?:\/\//i.test(source)) {
      const fetched = await fetchSubscription(source);
      if (!fetched.ok) return { ok: false, code: "fetch-failed", message: fetched.error };
      text = fetched.text;
    }
    const parsed = parseSubscription(text);
    if (!parsed.ok) return { ok: false, code: "parse-failed", message: parsed.error ?? "订阅解析失败" };
    const target = poolNow();
    target.setNodes(parsed.nodes);
    subscriptionNodes = parsed.nodes;
    const extra = { format: parsed.format, parsed: parsed.nodes.length, warnings: parsed.warnings };

    // 托管内核：节点是它的启动配置，改完得重起一次（stop → start 会重写 config.yaml）
    if (rules.coreManaged) {
      const restarted = await coreStop();
      void restarted;
      const started = await coreStart();
      if (!started.ok) {
        return { ok: false, code: started.code ?? "core-start-failed", message: "已解析 " + parsed.nodes.length + " 个节点，但托管内核起不来：" + (started.message ?? ""), value: extra };
      }
      const listedManaged = await listNodes();
      return { ok: true, value: { ...extra, ...(listedManaged.ok ? { snapshot: listedManaged.value } : { listError: listedManaged.message }) } };
    }

    if (coreApiNow().trim() === "") {
      return { ok: false, code: "no-core", message: "已解析 " + parsed.nodes.length + " 个节点，但没填内核 API 地址，无法导入", value: extra };
    }
    const patch = buildCorePatch(parsed.nodes, { group: rules.coreGroup });
    extra.skipped = patch.skipped;
    const applied = await adapterNow().apply(patch);
    if (!applied.ok) {
      return {
        ok: false,
        code: applied.code ?? "apply-failed",
        message: "解析成功（" + parsed.nodes.length + " 个节点），灌进内核失败：" + (applied.message ?? "") +
          "。也可以让内核自己订阅，然后点「读取节点」。",
        value: extra,
      };
    }
    const listed = await listNodes();
    return { ok: true, value: { ...extra, ...(listed.ok ? { snapshot: listed.value } : { listError: listed.message }) } };
  };

  /** 测所有节点（并发 4，经内核握手，VLESS/Hysteria2 的延迟只有内核测得准）。 */
  const testNodes = async () => {
    const target = poolNow();
    if (target.size === 0) {
      const loaded = await listNodes();
      if (!loaded.ok) return loaded;
    }
    const results = await target.testAll();
    return { ok: true, value: { results: results.value, snapshot: target.snapshot() } };
  };

  /** 定时巡检。只在开关打开且有内核地址时跑。 */
  let nodeTimer = null;
  const syncNodeTimer = () => {
    if (nodeTimer !== null) {
      clearInterval(nodeTimer);
      nodeTimer = null;
    }
    const rules = currentRules();
    if (!rules.nodesAuto || coreApiNow().trim() === "") return;
    nodeTimer = setInterval(() => {
      void poolNow().probeTick().catch((error) => logger.warn("model-proxy: probe failed: " + messageOf(error)));
    }, POOL_DEFAULTS.probeIntervalMs);
    // 别让定时器拖着进程退出
    if (typeof nodeTimer.unref === "function") nodeTimer.unref();
  };


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
    // 托管内核：出站代理地址由插件决定，用户填的 proxyUrl 让位。
    // 重启 DSH 后 subscriptionNodes 是空的 —— 直接起内核会得到一份没有节点、没有组的
    // config.yaml（界面那边表现为 group-missing、看不到节点）。有订阅就先拉一遍：
    // refreshSubscription 自己会写配置并起内核，随后 listNodes 把节点灌回池子。
    if (rules.coreManaged) {
      if (subscriptionNodes.length === 0 && rules.subscription.trim() !== "") {
        const refreshed = await refreshSubscription();
        if (!refreshed.ok) logger.warn("model-proxy: 订阅没拉起来 — " + (refreshed.message ?? ""));
      } else {
        const started = await coreStart();
        if (!started.ok) logger.warn("model-proxy: 托管内核没起来 — " + (started.message ?? ""));
      }
    }
    const normalized = normalizeProxyUrl(coreProxyUrl());
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
      // 代理不通 → 改直连的每一步都留一行日志：排查时能直接看到「什么时候、为什么切的」
      onFailover: (event) => {
        const text = `model-proxy: failover ${event.type} — ${event.message ?? ""}`;
        if (event.type === "recovered") logger.info(text);
        else logger.warn(text);
        // 代理链路真的挂了（预交付失败）→ 让节点池换一个可用节点。
        // 异步执行：本次请求照旧走直连降级，不在这里等内核切完。
        if (event.type === "proxy-failed" && currentRules().nodesAuto) {
          void poolNow()
            .failover("请求失败：" + (event.code ?? event.message ?? ""))
            .catch((error) => logger.warn("model-proxy: node failover failed: " + messageOf(error)));
        }
      },
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
  syncNodeTimer();

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
      // 订阅 / 内核地址 / 自动切换开关可能刚被改过
      syncNodeTimer();
      if (coreApiNow().trim() !== "") {
        void listNodes().catch(() => {});
      }
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
        // 降级状态是活的（每个请求都可能改），不能只在 sync 时快照，
        // 所以现取一份挂在 status 上，设置卡片的 /describe 直接看得到 state / 最近事件。
        getStatus: async () => {
          const health = getProxyHealth();
          return health === null ? lastStatus : { ...lastStatus, failover: health.snapshot };
        },
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
        nodes: {
          status: listNodes,
          refresh: refreshSubscription,
          test: testNodes,
          select: async (name) => {
            const result = await poolNow().switchTo(name, "手动切换");
            return result.ok ? { ok: true, value: poolNow().snapshot() } : result;
          },
        },
        core: {
          status: coreStatus,
          install: coreInstall,
          start: coreStart,
          stop: coreStop,
        },
        probe,
      }).map((route) => sctx.webServer.register(route));
      return () => {
        for (const dispose of routes) dispose();
      };
    }, "model-proxy: settings bridge");
  });

  // 插件被禁用/卸载时必须把全局 dispatcher 还原，否则整台 DSH 会永久走代理
  ctx.on("dispose", () => {
    if (nodeTimer !== null) {
      clearInterval(nodeTimer);
      nodeTimer = null;
    }
    // 托管内核是子进程：插件卸载/禁用必须收掉，否则端口和进程留在后台
    void coreStop();
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