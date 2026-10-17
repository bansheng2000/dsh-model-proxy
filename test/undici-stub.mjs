/**
 * 测试替身：只实现 lib/dispatcher.js 用到的那几个 undici 出口。
 *
 * 为什么需要它：lib/dispatcher.js 里是运行期 `await import("undici")`，而插件仓库自身
 * 没有 node_modules（undici 只存在于装机副本的依赖树里）。测试用 node:module 的 resolve
 * hook 把这个文件顶上去（见 test/dispatcher-race.mjs 与 test/undici-hook.mjs），
 * 这样才能在不碰真网络的前提下数清「装了几个 agent、关了没有」。
 *
 * 这不是被 mock 的业务逻辑：被测的是 dispatcher.js 的换装顺序与释放。
 */

export const instances = [];

/** 一次性故障开关（置位后下一次触发即复位），用来演练安装失败路径。 */
export const failures = { agent: false, setGlobal: false };

let global = { name: "host-default" };

export function getGlobalDispatcher() {
  return global;
}

export function setGlobalDispatcher(next) {
  if (failures.setGlobal) {
    failures.setGlobal = false;
    throw new Error("stub: setGlobalDispatcher failed");
  }
  global = next;
}

export function currentDispatcher() {
  return global;
}

/** 让 close() 永远不 resolve，用来测「优雅关闭卡住时按超时 destroy 收场」。 */
let hangClose = false;
export function setHangClose(value) {
  hangClose = value;
}

class Dispatcher {
  constructor(options = {}) {
    if (failures.agent) {
      failures.agent = false;
      throw new Error("stub: agent construction failed");
    }
    this.options = options;
    this.closed = false;
    this.destroyed = false;
    instances.push(this);
  }

  close() {
    if (hangClose) return new Promise(() => {});
    this.closed = true;
    return Promise.resolve();
  }

  destroy() {
    this.destroyed = true;
    this.closed = true;
  }
}

export class Agent extends Dispatcher {}
export class Pool extends Dispatcher {}
export class ProxyAgent extends Dispatcher {}

/** 还没被 close 的 agent 数（泄漏就是它 > 1）。 */
export function openCount() {
  return instances.filter((instance) => !instance.closed).length;
}

export function reset() {
  instances.length = 0;
  failures.agent = false;
  failures.setGlobal = false;
  global = { name: "host-default" };
}
