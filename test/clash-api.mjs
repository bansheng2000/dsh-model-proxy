// 自检：Clash 兼容 API 适配器。起一个假内核（本地 http server），不联网。
import assert from "node:assert/strict";
import http from "node:http";
import { createClashAdapter, normalizeBase } from "../lib/core-adapter.js";

let checks = 0;
const ok = async (label, fn) => { await fn(); checks += 1; process.stdout.write("PASS " + label + "\n"); };

/** 假内核：只实现适配器会用到的 4 个端点。 */
function startFakeCore() {
  const state = { selected: "A", patches: [], auth: null };
  const server = http.createServer(async (req, res) => {
    state.auth = req.headers.authorization ?? null;
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (url.pathname === "/version") return send(200, { version: "1.18.0", meta: true });
    if (url.pathname === "/proxies" && req.method === "GET") {
      return send(200, {
        proxies: {
          DSH: { type: "Selector", now: state.selected, all: ["A", "B", "C"] },
          A: { type: "Vless", history: [{ delay: 120 }] },
          B: { type: "Hysteria2", history: [] },
          C: { type: "Vless", history: [{ delay: 0 }] },
        },
      });
    }
    const delayMatch = /^\/proxies\/([^/]+)\/delay$/.exec(url.pathname);
    if (delayMatch !== null && req.method === "GET") {
      const name = decodeURIComponent(delayMatch[1]);
      if (name === "A") return send(200, { delay: 123 });
      if (name === "C") return send(200, { delay: 0 });
      return send(503, { message: "An error occurred in the delay test" });
    }
    const selectMatch = /^\/proxies\/([^/]+)$/.exec(url.pathname);
    if (selectMatch !== null && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      state.selected = body.name;
      return send(204);
    }
    if (url.pathname === "/configs" && req.method === "PATCH") {
      state.patches.push(JSON.parse(await readBody(req)));
      return send(204);
    }
    return send(404, { message: "not found" });
  });
  const ready = new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  return { state, ready, close: () => server.close() };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const fake = startFakeCore();
const port = await fake.ready;
const adapter = createClashAdapter({ baseUrl: "127.0.0.1:" + port, secret: "s3cret", group: "DSH" });

await ok("ping：认出 Clash 兼容内核", async () => {
  const result = await adapter.ping();
  assert.equal(result.ok, true);
  assert.equal(result.version, "1.18.0");
  assert.equal(result.meta, true);
});

await ok("list：读组内成员 + 最近延迟 + 当前选中", async () => {
  const result = await adapter.list();
  assert.equal(result.ok, true);
  assert.equal(result.value.current, "A");
  assert.deepEqual(result.value.nodes.map((n) => n.name), ["A", "B", "C"]);
  assert.equal(result.value.nodes[0].latencyMs, 120);
  assert.equal(result.value.nodes[1].latencyMs, null);
  assert.equal(result.value.nodes[2].latencyMs, null); // delay:0 视为未知
});

await ok("delay：可用节点返回延迟", async () => {
  const result = await adapter.delay("A", { url: "https://www.gstatic.com/generate_204", timeoutMs: 2000 });
  assert.equal(result.ok, true);
  assert.equal(result.latencyMs, 123);
});

await ok("delay：内核报错时返回 ok:false 而不是抛", async () => {
  const result = await adapter.delay("B");
  assert.equal(result.ok, false);
  assert.equal(result.code, "http-503");
});

await ok("delay：delay=0 当作测不出来", async () => {
  const result = await adapter.delay("C");
  assert.equal(result.ok, false);
  assert.equal(result.code, "no-delay");
});

await ok("select：PUT 到组名，内核侧选中项真的变了", async () => {
  const result = await adapter.select("B");
  assert.equal(result.ok, true);
  assert.equal(fake.state.selected, "B");
});

await ok("apply：PATCH /configs 带 proxies 与 proxy-groups", async () => {
  const result = await adapter.apply({
    proxies: [{ name: "A", type: "vless" }],
    proxyGroups: [{ name: "DSH", type: "select", proxies: ["A"] }],
  });
  assert.equal(result.ok, true);
  assert.equal(fake.state.patches.length, 1);
  assert.deepEqual(fake.state.patches[0]["proxy-groups"], [{ name: "DSH", type: "select", proxies: ["A"] }]);
  assert.equal(fake.state.patches[0].proxies[0].name, "A");
});

await ok("带 secret 时发 Bearer 头", async () => {
  await adapter.ping();
  assert.equal(fake.state.auth, "Bearer s3cret");
});

await ok("组名不存在时给出可操作的错误", async () => {
  const other = createClashAdapter({ baseUrl: "127.0.0.1:" + port, group: "NOPE" });
  const result = await other.list();
  assert.equal(result.ok, false);
  assert.equal(result.code, "group-missing");
  assert.match(result.message, /NOPE/);
});

await ok("内核连不上时返回 unreachable 而不是抛", async () => {
  const dead = createClashAdapter({ baseUrl: "127.0.0.1:1", timeoutMs: 500 });
  const result = await dead.ping();
  assert.equal(result.ok, false);
  assert.ok(["unreachable", "timeout"].includes(result.code));
});

await ok("normalizeBase：只允许回环地址", async () => {
  assert.equal(normalizeBase("").ok, false);
  assert.equal(normalizeBase("http://1.2.3.4:9090").ok, false);
  const good = normalizeBase("127.0.0.1:9090/");
  assert.equal(good.ok, true);
  assert.equal(good.url, "http://127.0.0.1:9090");
  assert.equal(normalizeBase("localhost:9090/api").url, "http://localhost:9090/api");
});

fake.close();
process.stdout.write("clash-api: " + checks + " checks passed\n");
