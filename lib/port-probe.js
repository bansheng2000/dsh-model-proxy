/**
 * 本地代理端口存活探测（只用于界面提示）。
 *
 * 三条硬约束：
 *  1. **只探本机/私网**：127.x / ::1 / localhost / 10 / 172.16-31 / 192.168 / 169.254。
 *     公网主机一律返回 null（不探测）—— 这个提示绝不能被当成对外端口扫描器。
 *  2. 单次探测 300ms 上限，超时算 unknown（null）：探不到就说不知道，绝不说「活着」。
 *  3. 结果短缓存（2s），只在面板打开 / 保存时刷新，不进任何请求热路径。
 */
import net from "node:net";

import { hostMatches, isLoopbackHost, isPrivateHost } from "./policy.js";

export const PORT_PROBE = Object.freeze({ timeoutMs: 300, ttlMs: 2000 });

/** host:port → { at, alive }。只缓存本机/私网目标，键很短，不会长。 */
const cache = new Map();

/**
 * 用户填的代理地址 → 要探的 host:port；不该探的情况一律 null。
 *
 * 跳过：空串、解析失败、协议不是 http/https、非本机/私网主机、bypass 命中。
 *
 * @param {string} raw
 * @param {{bypass?: readonly string[]}} [options]
 * @returns {{host: string, port: number}|null}
 */
export function proxyPortTarget(raw, { bypass = [] } = {}) {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "") return null;
  if (!(isLoopbackHost(host) || isPrivateHost(host))) return null; // 公网：绝不探
  const fallback = url.protocol === "https:" ? 443 : 80;
  const port = url.port === "" ? fallback : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (bypass.some((pattern) => hostMatches(pattern, host, String(port)))) return null;
  return { host, port };
}

/**
 * 探一次端口。true = 有人监听；false = 明确连不上（ECONNREFUSED）；null = 不知道。
 *
 * 只有 ECONNREFUSED 算「明确没人」—— 那正是本地代理没启动的样子。
 * 超时 / 其它错误一律 unknown，不能拿来当结论。
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean|null>}
 */
export function probePort(host, port, timeoutMs = PORT_PROBE.timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        /* 已经关了 */
      }
      resolve(value);
    };
    const socket = net.connect({ host, port });
    socket.unref?.(); // 探测绝不能拖住宿主退出
    timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(error?.code === "ECONNREFUSED" ? false : null));
  });
}

/**
 * 带缓存地判断某个代理地址的端口是否有人监听。
 *
 * @param {string} raw
 * @param {{bypass?: readonly string[], timeoutMs?: number, ttlMs?: number, now?: () => number}} [options]
 * @returns {Promise<{host: string, port: number, alive: boolean|null}|null>} null = 不适用（跳过）
 */
export async function checkProxyPort(raw, options = {}) {
  const target = proxyPortTarget(raw, options);
  if (target === null) return null;
  const ttlMs = options.ttlMs ?? PORT_PROBE.ttlMs;
  const now = options.now ?? (() => Date.now());
  const key = `${target.host}:${target.port}`;
  const hit = cache.get(key);
  if (hit !== undefined && now() - hit.at < ttlMs) return { ...target, alive: hit.alive };
  const alive = await probePort(target.host, target.port, options.timeoutMs ?? PORT_PROBE.timeoutMs);
  cache.set(key, { at: now(), alive });
  return { ...target, alive };
}

/** 测试用：清掉缓存，免得上一个用例的结论串味。 */
export function resetPortProbeCache() {
  cache.clear();
}
