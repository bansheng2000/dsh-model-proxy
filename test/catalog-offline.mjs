/**
 * 离线验证 catalog 处理器（不依赖 DSH 运行时）。
 *
 * 目的：证明 rows=0 的两个根因已被修掉。
 * 根因 A：桥 scope 从未 inject "llm" → listProviders() 返回 []。
 * 根因 B：buildCatalog 的 typeof provider !== "string" 守卫把 LlmProviderInfo[] 全丢掉。
 *
 * 这里直接 import profile 里已安装的那份 bridge.js（而非工作区副本），
 * 用假的 settings / llm 喂进去，验证 handlers.catalog() 真的产出 rows。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Windows 上绝对路径必须转成 file:// URL，否则 ESM 报 ERR_UNSUPPORTED_ESM_URL_SCHEME。
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

const { makeBridgeRoutes } = await fromProfile("bridge.js");
const { buildCatalog } = await fromProfile("providers.js");

// 真实契约：@Remote listProviders(): LlmProviderInfo[]，元素是 {id, name}（不是字符串）。
const FAKE_PROVIDERS = [
  { id: "opencode2dsh", name: "OpenCode (free)" },
  { id: "deepseek", name: "DeepSeek" },
  { id: "pi-ai", name: "pi-ai gateway" },
];

// settings.describe({redactSecrets:true}) 的形状：ns + value。
// 前两个形态各来一个：命名空间里带 providers 表 / 命名空间本身就是 provider id。
const FAKE_DESCRIPTORS = [
  { ns: "llm-pi-ai", value: { providers: { "pi-ai": { api: "http://127.0.0.1:4141/v1", apiKeyEnv: "X" } } } },
  { ns: "llm-deepseek-api-key", value: { baseURL: "https://api.deepseek.com/v1", models: [] } },
  { ns: "model-proxy", value: { rules: { enabled: false } } },
];

const settings = {
  describe: (opts) => {
    if (opts?.redactSecrets !== true) throw new Error("catalog must ask for redacted secrets");
    return FAKE_DESCRIPTORS;
  },
  mutate: async () => ({}),
};

// llm seam 已 inject 时的形态：直接返回 LlmProviderInfo[]，不 spread。
const listProviders = async () => FAKE_PROVIDERS;

const routes = makeBridgeRoutes({
  settings,
  ns: "model-proxy",
  getStatus: async () => ({ active: false, reason: "插件未启用", mode: "off" }),
  getConfig: () => ({}),
  listProviders,
  getObserved: async () => ({}),
});

const catalogRoute = routes.find((r) => r.path.endsWith("/catalog"));
if (!catalogRoute) throw new Error("catalog route missing");

// 用一个最小 IncomingMessage 替身触发 handler。
const res = {
  statusCode: null,
  body: null,
  writeHead(status) { this.statusCode = status; },
  end(chunk) { this.body = chunk; },
};
await catalogRoute.handler(
  { method: "GET", socket: { remoteAddress: "127.0.0.1" } },
  res,
);

const payload = JSON.parse(res.body);
console.log("http status      :", res.statusCode);
console.log("ok               :", payload.ok);
if (!payload.ok) {
  console.log("code/message     :", payload.code, payload.message);
  process.exit(1);
}

const { rows, diagnostics } = payload.value;
console.log("rows             :", rows.length);
console.log("diagnostics keys :", Object.keys(diagnostics ?? {}).join(","));
console.table(
  rows.map((r) => ({
    provider: r.provider,
    displayName: r.displayName,
    hosts: (r.hosts ?? []).join(" | "),
  })),
);

const failures = [];
if (rows.length === 0) failures.push("rows 仍为 0：两个根因至少还有一个没修掉");
if (!rows.some((r) => r.provider === "opencode2dsh")) failures.push("缺少 opencode2dsh（只有出厂 host 兜底也应出现）");
if (!rows.some((r) => r.provider === "pi-ai")) failures.push("缺少 pi-ai（应由 harvestDeclaredHosts 从 llm-pi-ai 命名空间解出 127.0.0.1:4141）");
if (!diagnostics || typeof diagnostics.providerCount !== "number") failures.push("diagnostics 缺失：跑的还是旧 bridge.js");

console.log("\nproviders 长这样 :", JSON.stringify(buildCatalog({ providers: FAKE_PROVIDERS, providerConfig: {}, discovered: [] }).map((r) => r.provider)));

// ── 降级路径：llm seam 缺席 / 抛错时，整页不能崩 ────────────────────────────
// 真实场景：写进 ctx.inject(["webServer","settings","llm"]) 会让缺 llm 的组合
// 整个 fiber 永不激活、卡片直接 401 消失。现在改成运行时 sctx.get("llm") 懒取，
// 所以必须验证这两种情况下 /catalog 仍然 ok 且 rows 非空（至少有 declared 兜底）。
async function runCatalog(label, listProvidersImpl) {
  const r = makeBridgeRoutes({
    settings,
    ns: "model-proxy",
    getStatus: async () => ({ active: false, reason: "插件未启用", mode: "off" }),
    getConfig: () => ({}),
    listProviders: listProvidersImpl,
    getObserved: async () => ({}),
  }).find((x) => x.path.endsWith("/catalog"));
  const sink = {
    statusCode: null, body: null,
    writeHead(s) { this.statusCode = s; },
    end(c) { this.body = c; },
  };
  await r.handler({ method: "GET", socket: { remoteAddress: "127.0.0.1" } }, sink);
  const parsed = JSON.parse(sink.body);
  console.log(`\n[${label}] http=${sink.statusCode} ok=${parsed.ok} rows=${parsed.value?.rows?.length ?? "n/a"}`,
    "providers=", JSON.stringify(parsed.value?.rows?.map((x) => x.provider) ?? []));
  return parsed;
}

const llmAbsent = await runCatalog("llm 缺席", async () => []);
if (!llmAbsent.ok) failures.push("llm 缺席时 /catalog 应仍 ok，实际 " + llmAbsent.code + ": " + llmAbsent.message);
else if (llmAbsent.value.rows.length === 0) failures.push("llm 缺席时 rows 为空：用户无从勾选，应由 declared 兜底");
else if (llmAbsent.value.diagnostics.providerError !== null) failures.push("llm 缺席不应算 providerError");

const llmThrew = await runCatalog("llm 抛错", async () => { throw new Error("seam exploded"); });
if (!llmThrew.ok) failures.push("llm 抛错时 /catalog 应降级为 ok，实际 " + llmThrew.code);
else if (!llmThrew.value.diagnostics.providerError?.includes("seam exploded")) {
  failures.push("llm 抛错时 providerError 应带上原始信息，实际 " + JSON.stringify(llmThrew.value.diagnostics.providerError));
}

// declared 独有的 provider（llm 没登记）也必须出现在列表里
const declaredOnly = llmAbsent.value.rows.map((r) => r.provider);
if (!declaredOnly.includes("pi-ai")) failures.push("declared 里的 pi-ai 未出现在 llm 缺席时的列表：" + JSON.stringify(declaredOnly));
if (!declaredOnly.includes("llm-deepseek-api-key")) {
  failures.push("命名空间型 declared provider(llm-deepseek-api-key) 未出现：" + JSON.stringify(declaredOnly));
}
// host 兜底：pi-ai 应拿到 127.0.0.1:4141
const piRow = llmAbsent.value.rows.find((r) => r.provider === "pi-ai");
if (!piRow?.hosts?.some((h) => h.startsWith("127.0.0.1:4141"))) {
  failures.push("pi-ai 应命中 harvestDeclaredHosts 解出的 127.0.0.1:4141，实际 " + JSON.stringify(piRow?.hosts));
}

console.log(failures.length === 0 ? "\nPASS" : `\nFAIL\n- ${failures.join("\n- ")}`);
process.exit(failures.length === 0 ? 0 : 1);
