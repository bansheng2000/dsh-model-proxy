/**
 * 端到端实测：用**真实 NekoBox 代理**验证「勾选的走代理 / 未勾选的直连」。
 *
 * 与 selftest.mjs 的区别：selftest 用本地假代理 + 局域网 IP 做确定性验证；
 * 这里打真实的 127.0.0.1:2080，靠「出口 IP 是否变化」判断是否真的走了代理。
 * 本机直连 ipify 会失败（已实测 fetch failed），所以：
 *   - 命中代理 → 返回 NekoBox 的出口 IP
 *   - 直连     → 连接失败
 * 这是一个天然的、非人工的判定信号。
 *
 * 用法：node test/live-proxy.mjs
 * 环境变量：SELFTEST_PROXY_URL（默认 http://127.0.0.1:2080）
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 默认取本机桌面版 profile 里已安装的那份；换 profile 用 DSH_PROFILE / DSH_PROFILE_LIB 覆盖。
const PROFILE_LIB = pathToFileURL(
  process.env.DSH_PROFILE_LIB ??
    join(
      homedir(),
      ".dsh",
      "profiles",
      process.env.DSH_PROFILE ?? "desktop",
      "node_modules",
      "dsh-model-proxy",
      "lib",
    ),
).href;
const fromProfile = (file) => import(`${PROFILE_LIB}/${file}`);

const { applyProxyPlan, disposeProxyPlan, planFromConfig } = await fromProfile("dispatcher.js");
const { createHostResolver } = await fromProfile("providers.js");

const PROXY_URL = process.env.SELFTEST_PROXY_URL ?? "http://127.0.0.1:2080";

// 目标分两类：
// - CHECKED_HOST：被勾选 → 应走代理（能通，出口 IP 是 NekoBox 的）
// - DIRECT_HOST ：未勾选 → 应直连（本机不通，故期望 fetch failed）
// 用两个完全不同的真实域名，避免「同 host 连带代理」掩盖结果。
const CHECKED = "api.anthropic.com";
const DIRECT = "api.openai.com";
const IP_URL = "http://api.ipify.org?format=json";
const PROBE_URL = "https://api.anthropic.com/v1/models";

function hostsForProvider() {
  return [CHECKED];
}
const knownProvider = (p) => p === "anthropic";

const failures = [];
function note(label, actual, expected) {
  const good = actual === expected;
  console.log(`${good ? "PASS" : "FAIL"}  ${label}: ${actual} (期望 ${expected})`);
  if (!good) failures.push(`${label}: ${actual} != ${expected}`);
}

/** 打一次出口 IP 探测，返回 {ok, ip, error}。 */
async function whoAmI() {
  try {
    const res = await fetch(IP_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: `status ${res.status}` };
    return { ok: true, ip: (await res.json()).ip };
  } catch (error) {
    return { ok: false, error: error?.cause?.code ?? error?.message ?? "unknown" };
  }
}

/**
 * 访问一个地址，并记录 dispatcher 对它作出的判定。
 *
 * 不能用「出口 IP」来判定单次请求——探测 ipify 的那个请求本身也要过判定，
 * 在 allowlist 下它会直连然后超时，反而把真实结果掩盖掉。所以判定信号必须来自
 * dispatcher 自己（onDecision），连通性则单独看请求结果。
 */
async function visit(url, decisions) {
  decisions.length = 0;
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(25000), redirect: "manual" });
    return { reached: true, status: res.status, proxied: decisions.some((d) => d.proxied) };
  } catch (error) {
    return {
      reached: false,
      status: null,
      proxied: decisions.some((d) => d.proxied),
      error: error?.cause?.code ?? error?.message ?? "unknown",
    };
  }
}

console.log("代理地址        :", PROXY_URL);
console.log("勾选 provider   : anthropic →", CHECKED);
console.log("未勾选 provider : 其他      →", DIRECT);
console.log();

// ── 1. 先确认 NekoBox 本身是活的：everything 模式下任何出口都该通 ────────────
const decisions = [];
let proxyExitIp = null;
{
  const plan = planFromConfig({
    mode: "everything", selected: [], bypass: [],
    hostsForProvider, knownProvider, proxyUrl: PROXY_URL,
  });
  const installed = await applyProxyPlan(plan, { enabled: true, onDecision: (d) => decisions.push(d) });
  if (!installed.active) {
    console.log("FAIL  安装失败:", installed.reason);
    process.exit(1);
  }
  const ip = await whoAmI();
  if (ip.ok) proxyExitIp = ip.ip;
  console.log(`代理出口        : ${proxyExitIp ?? "不通(" + ip.error + ")"}`);
  await disposeProxyPlan();
}
if (proxyExitIp === null) {
  console.log("\nNekoBox 代理不通，无法做端到端判定，退出(2)。");
  process.exit(2);
}
note("everything 模式可达", true, true);

// ── 2. allowlist 模式：只有勾选的 host 走代理 ────────────────────────────────
const plan = planFromConfig({
  mode: "allowlist",
  selected: ["anthropic"],
  bypass: [],
  hostsForProvider,
  knownProvider,
  proxyUrl: PROXY_URL,
});
const installed = await applyProxyPlan(plan, { enabled: true, onDecision: (d) => decisions.push(d) });
if (!installed.active) {
  console.log("FAIL  安装失败:", installed.reason);
  process.exit(1);
}

const viaProxy = await visit(PROBE_URL, decisions);
const viaDirect = await visit(`https://${DIRECT}/v1/models`, decisions);

console.log();
note("勾选 host 被判定为走代理", viaProxy.proxied, true);
note("勾选 host 经代理可达(收到 HTTP 响应)", viaProxy.reached, true);
note("未勾选 host 被判定为直连", viaDirect.proxied, false);
if (!viaDirect.reached) console.log(`      （未勾选 host 直连失败: ${viaDirect.error} —— 符合本机需翻墙的前提）`);

// ── 3. 关闭后必须恢复直连 ──────────────────────────────────────────────────
await disposeProxyPlan();
const after = await visit(PROBE_URL, decisions);
note("dispose 后不再经代理", after.proxied, false);

// 顺手验证 host 解析器：勾选项应翻译成 host
const resolver = createHostResolver({ declared: { anthropic: [`https://${CHECKED}/v1`] }, observed: {} });
note("host 解析器", resolver("anthropic").join(","), CHECKED);

console.log(failures.length === 0 ? "\nPASS 端到端实测通过" : `\nFAIL\n- ${failures.join("\n- ")}`);
process.exit(failures.length === 0 ? 0 : 1);
