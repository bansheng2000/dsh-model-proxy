/**
 * dsh-model-proxy — 节点池与自动切换
 *
 * 职责很窄：记住一批节点谁可用、延迟多少、当前用谁；代理不通时换下一个。
 * 不碰网络（网络都在 core-adapter 里），所以可以用假 adapter 单测。
 *
 * 切换的三条触发（index.js 接线）：
 *   1. 请求失败 —— dispatcher 的 onFailover 事件；
 *   2. 定时巡检 —— probeTick()，当前节点连续 2 次测不通就切；
 *   3. 手动 —— 卡片里点某个节点。
 *
 * 防抖：同一次故障只切一次（minSwitchGapMs），并且每小时最多切 maxSwitchesPerHour 次，
 * 否则一条烂链路会让内核组被反复 select，反而更不稳。
 */

export const POOL_DEFAULTS = Object.freeze({
  probeIntervalMs: 60000,
  minSwitchGapMs: 30000,
  maxSwitchesPerHour: 12,
  testConcurrency: 4,
  // 订阅节点握手常 2~5s，3s 会把能用的节点全判成超时
  testTimeoutMs: 8000,
  failStreakToSwitch: 2,
});

/**
 * @param {object} options
 * @param {{delay: Function, select: Function}} options.adapter 内核适配器
 * @param {() => number} [options.now]
 * @param {(line: string) => void} [options.log]
 * @param {object} [options.tuning] 覆盖 POOL_DEFAULTS 里的阈值
 */
export function createNodePool(options) {
  const adapter = options.adapter;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const config = { ...POOL_DEFAULTS, ...(options.tuning ?? {}) };

  /** name -> 健康度。节点本身（server/port/密钥）不在这里，池只记名字与统计。 */
  const nodes = new Map();
  let current = null;
  let switches = [];
  let lastSwitchAt = 0;
  let lastError = null;

  const blank = (node) => ({
    name: node.name,
    protocol: node.protocol ?? "",
    server: node.server ?? "",
    port: node.port ?? 0,
    latencyMs: null,
    ok: null,
    failures: 0,
    streak: 0,
    lastTestAt: 0,
  });

  const pool = {
    /** 整体替换节点清单；同名节点保留已有的延迟/失败统计（刷新订阅不清零健康度）。 */
    setNodes(list) {
      const next = new Map();
      for (const raw of list ?? []) {
        if (typeof raw?.name !== "string" || raw.name === "") continue;
        next.set(raw.name, nodes.get(raw.name) ?? blank(raw));
      }
      nodes.clear();
      for (const [name, value] of next) nodes.set(name, value);
      if (current !== null && !nodes.has(current)) current = null;
      return { ok: true, count: nodes.size };
    },

    get size() {
      return nodes.size;
    },

    get current() {
      return current;
    },

    setCurrent(name) {
      if (name !== null && !nodes.has(name)) return false;
      current = name;
      return true;
    },

    /** 从磁盘缓存恢复健康度（延迟/可用/失败次数）：重启后界面立刻有数据，不用先测一轮。 */
    restoreRows(rows) {
      for (const row of rows ?? []) {
        const node = nodes.get(row?.name ?? "");
        if (node === undefined) continue;
        if (typeof row.latencyMs === "number" && row.latencyMs > 0) node.latencyMs = row.latencyMs;
        if (row.ok === true || row.ok === false) node.ok = row.ok;
        node.failures = Number(row.failures ?? 0);
        node.streak = Number(row.streak ?? 0);
        node.lastTestAt = Number(row.lastTestAt ?? 0);
      }
      return { ok: true };
    },

    /** 前端视图。节点里本来就没有密钥（订阅解析时只留名字/协议/地址）。 */
    snapshot() {
      return {
        current,
        lastSwitchAt: lastSwitchAt === 0 ? null : lastSwitchAt,
        switchesLastHour: switches.length,
        lastError,
        nodes: [...nodes.values()].sort(rank),
      };
    },

    markFailed(name) {
      const node = nodes.get(name ?? "");
      if (node === undefined) return;
      node.failures += 1;
      node.streak += 1;
      node.ok = false;
      lastError = name + " 不可用";
    },

    markOk(name, latencyMs) {
      const node = nodes.get(name ?? "");
      if (node === undefined) return;
      node.ok = true;
      node.streak = 0;
      node.lastTestAt = now();
      if (typeof latencyMs === "number" && latencyMs > 0) node.latencyMs = latencyMs;
    },

    /** 可用的最优节点（排除指定名字）：可用 > 未测 > 失败，同档按延迟升序。 */
    best(exclude) {
      const candidates = [...nodes.values()].filter((node) => node.name !== exclude);
      const healthy = candidates.filter((node) => node.ok === true);
      const poolOf = healthy.length > 0 ? healthy : candidates.filter((node) => node.ok === null);
      return poolOf.sort(rank)[0] ?? null;
    },

    /**
     * 切到指定节点。限流/失败时返回 {ok:false, code}，调用方据此决定是否降级直连。
     * @param {string} name
     * @param {string} reason 写进日志，排查时能看到「因为什么切的」
     */
    async switchTo(name, reason) {
      if (!nodes.has(name)) return { ok: false, code: "unknown-node", message: "节点不存在：" + name };
      if (name === current) return { ok: false, code: "already-current", message: "已经是当前节点" };
      const at = now();
      if (at - lastSwitchAt < config.minSwitchGapMs) {
        return { ok: false, code: "too-soon", message: "距上次切换不足 " + Math.round(config.minSwitchGapMs / 1000) + "s，先不动" };
      }
      switches = switches.filter((time) => at - time < 3600000);
      if (switches.length >= config.maxSwitchesPerHour) {
        return { ok: false, code: "rate-limited", message: "最近一小时已切换 " + switches.length + " 次，暂停自动切换" };
      }
      const result = await adapter.select(name);
      if (!result.ok) {
        lastError = result.message ?? "切换失败";
        return { ok: false, code: result.code ?? "select-failed", message: lastError };
      }
      current = name;
      lastSwitchAt = at;
      switches.push(at);
      log("node -> " + name + "（" + reason + "）");
      return { ok: true, value: { name, reason } };
    },

    /** 代理不通时的标准动作：标记失败，再挑一个能用的。 */
    async failover(reason) {
      if (current === null) {
        const next = pool.best(null);
        if (next === null) return { ok: false, code: "no-nodes", message: "节点池是空的，先刷新订阅" };
        return pool.switchTo(next.name, reason);
      }
      pool.markFailed(current);
      const next = pool.best(current);
      if (next === null) {
        return { ok: false, code: "no-healthy-node", message: current + " 不可用，且没有其他可用节点" };
      }
      return pool.switchTo(next.name, reason);
    },

    /** 测一个节点（经内核），并更新健康度。 */
    async test(name) {
      if (!nodes.has(name ?? "")) return { ok: false, code: "unknown-node", message: "节点不存在：" + name };
      const result = await adapter.delay(name, { timeoutMs: config.testTimeoutMs });
      if (result.ok) {
        pool.markOk(name, result.latencyMs);
        return { ok: true, value: { name, latencyMs: result.latencyMs } };
      }
      pool.markFailed(name);
      return { ok: false, code: result.code ?? "delay-failed", message: result.message };
    },

    /** 并发测所有节点（默认 4，别把内核打瘫）。 */
    async testAll() {
      const names = [...nodes.keys()];
      const results = [];
      let index = 0;
      const worker = async () => {
        while (index < names.length) {
          const name = names[index];
          index += 1;
          results.push(await pool.test(name));
        }
      };
      const width = Math.max(1, Math.min(config.testConcurrency, names.length));
      await Promise.all(Array.from({ length: width }, worker));
      return { ok: true, value: results };
    },

    /** 定时巡检：测当前节点，连续 failStreakToSwitch 次不通就换。 */
    async probeTick() {
      if (current === null) return { ok: false, code: "no-current", message: "没有当前节点" };
      const result = await adapter.delay(current, { timeoutMs: config.testTimeoutMs });
      if (result.ok) {
        pool.markOk(current, result.latencyMs);
        return { ok: true, value: { name: current, latencyMs: result.latencyMs } };
      }
      pool.markFailed(current);
      const node = nodes.get(current);
      if (node !== undefined && node.streak >= config.failStreakToSwitch) {
        const switched = await pool.failover("巡检连续 " + node.streak + " 次不通");
        return { ok: switched.ok, value: switched.value, message: switched.message };
      }
      return { ok: false, code: "probe-failed", message: result.message };
    },

    tuning: config,
  };

  return pool;
}

/** 排序：可用 > 未知 > 失败；同档按延迟升序，再按失败次数升序。 */
function rank(a, b) {
  const score = (node) => (node.ok === true ? 0 : node.ok === null ? 1 : 2);
  if (score(a) !== score(b)) return score(a) - score(b);
  const la = a.latencyMs ?? Number.MAX_SAFE_INTEGER;
  const lb = b.latencyMs ?? Number.MAX_SAFE_INTEGER;
  if (la !== lb) return la - lb;
  return a.failures - b.failures;
}