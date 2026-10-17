/**
 * node:module 的 resolve hook：只在测试进程里把 `undici` 顶成 test/undici-stub.mjs。
 *
 * 用法（见 test/dispatcher-race.mjs）：
 *   import { register } from "node:module";
 *   register("./undici-hook.mjs", import.meta.url);
 *   const { applyProxyPlan } = await import("../lib/dispatcher.js");
 * 必须用动态 import 载入被测模块 —— 静态 import 会在 register 之前求值。
 */
export async function resolve(specifier, context, next) {
  if (specifier === "undici") {
    return { url: new URL("./undici-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
