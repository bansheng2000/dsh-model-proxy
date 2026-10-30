// 自检：订阅解析 + 节点 → 内核配置。不联网。
import assert from "node:assert/strict";
import { buildCorePatch, fromClashYaml, parseShareLink, parseSubscription, redact, toMihomoProxy, tryBase64Text } from "../lib/subscription.js";

let checks = 0;
const ok = (label, fn) => { fn(); checks += 1; process.stdout.write("PASS " + label + "\n"); };

ok("vless 分享链接 → 节点 + mihomo 条目（reality + ws）", () => {
  const line = "vless://11111111-2222-3333-4444-555555555555@hk.example.com:443?encryption=none&security=reality&sni=www.apple.com&fp=chrome&pbk=PUBKEY&sid=abcd&type=ws&host=cdn.example.com&path=%2Fws&flow=xtls-rprx-vision#HK-01";
  const node = parseShareLink(line);
  assert.equal(node.protocol, "vless");
  assert.equal(node.name, "HK-01");
  assert.equal(node.server, "hk.example.com");
  assert.equal(node.port, 443);
  const proxy = toMihomoProxy(node);
  assert.equal(proxy.type, "vless");
  assert.equal(proxy.uuid, "11111111-2222-3333-4444-555555555555");
  assert.equal(proxy.tls, true);
  assert.deepEqual(proxy["reality-opts"], { "public-key": "PUBKEY", "short-id": "abcd" });
  assert.equal(proxy.network, "ws");
  assert.equal(proxy["ws-opts"].path, "/ws");
  assert.equal(proxy["ws-opts"].headers.Host, "cdn.example.com");
  assert.equal(proxy.flow, "xtls-rprx-vision");
});

ok("hysteria2 分享链接（含 obfs）", () => {
  const node = parseShareLink("hysteria2://pass123@jp.example.com:8443?sni=jp.example.com&insecure=1&obfs=salamander&obfs-password=obfspw#JP-01");
  assert.equal(node.protocol, "hysteria2");
  assert.equal(node.secret, "pass123");
  const proxy = toMihomoProxy(node);
  assert.equal(proxy.type, "hysteria2");
  assert.equal(proxy.password, "pass123");
  assert.equal(proxy.obfs, "salamander");
  assert.equal(proxy["obfs-password"], "obfspw");
  assert.equal(proxy["skip-cert-verify"], true);
});

ok("hy2:// 视同 hysteria2", () => {
  const node = parseShareLink("hy2://pw@host.example.com:443#X");
  assert.equal(node.protocol, "hysteria2");
});

ok("ss:// 两种写法", () => {
  const a = parseShareLink("ss://" + Buffer.from("aes-256-gcm:pw").toString("base64") + "@1.2.3.4:8388#A");
  assert.equal(a.protocol, "ss");
  assert.equal(a.extra.cipher, "aes-256-gcm");
  const b = parseShareLink("ss://" + Buffer.from("aes-256-gcm:pw@1.2.3.4:8388").toString("base64") + "#B");
  assert.equal(b.server, "1.2.3.4");
  assert.equal(b.port, 8388);
});

ok("整段 base64 分享链接列表", () => {
  const list = ["vless://uuid-a@a.example.com:443#A", "vless://uuid-b@b.example.com:8443#B"].join("\n");
  const encoded = Buffer.from(list).toString("base64");
  const parsed = parseSubscription(encoded);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format, "share-links");
  assert.equal(parsed.nodes.length, 2);
  assert.deepEqual(parsed.nodes.map((n) => n.name), ["A", "B"]);
});

ok("Clash YAML 原样保留 proxies 条目", () => {
  const yaml = [
    "proxies:",
    "  - name: HK-02",
    "    type: vless",
    "    server: hk2.example.com",
    "    port: 443",
    "    uuid: abc",
    "    tls: true",
    "    network: ws",
    "  - name: JP-02",
    "    type: hysteria2",
    "    server: jp2.example.com",
    "    port: 8443",
    "    password: pw",
  ].join("\n");
  const parsed = parseSubscription(yaml);
  assert.equal(parsed.format, "clash-yaml");
  assert.equal(parsed.nodes.length, 2);
  const patch = buildCorePatch(parsed.nodes, { group: "DSH" });
  assert.equal(patch.proxies.length, 2);
  assert.deepEqual(patch.proxyGroups, [{ name: "DSH", type: "select", proxies: ["HK-02", "JP-02"] }]);
  assert.equal(patch.proxies[0].uuid, "abc");
});

ok("Clash YAML 缺字段给 warning 而不是抛错", () => {
  const parsed = fromClashYaml("proxies:\n  - name: broken\n  - name: ok\n    type: ss\n    server: s.example.com\n    port: 1\n    cipher: aes-128-gcm\n    password: p");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.warnings.length, 1);
});

ok("sing-box JSON 只取 outbound 基本字段", () => {
  const parsed = parseSubscription(JSON.stringify({ outbounds: [
    { type: "selector", tag: "proxy", outbounds: ["a"] },
    { type: "vless", tag: "a", server: "x.example.com", server_port: 443, uuid: "u" },
  ] }));
  assert.equal(parsed.format, "singbox-json");
  assert.equal(parsed.nodes.length, 1);
  assert.equal(parsed.nodes[0].name, "a");
});

ok("不支持的协议要报出来：分享链接进 warnings，Clash 条目进 skipped", () => {
  const parsed = parseSubscription(["vless://u@a.example.com:443#A", "tuic://u:p@b.example.com:443#B"].join("\n"));
  assert.equal(parsed.nodes.length, 1);
  assert.match(parsed.warnings.join(" | "), /tuic/);
  // Clash 条目由内核自己解释（mihomo 认识 tuic 等），原样透传
  const fromClash = parseSubscription("proxies:\n  - {name: T, type: tuic, server: t.example.com, port: 443}");
  assert.equal(buildCorePatch(fromClash.nodes).proxies[0].type, "tuic");
  // sing-box outbound 是我们自己翻译的，遇到不认识的类型必须进 skipped
  const box = parseSubscription(JSON.stringify({ outbounds: [{ type: "wireguard", tag: "W", server: "w.example.com", server_port: 51820 }] }));
  const patch = buildCorePatch(box.nodes);
  assert.equal(patch.proxies.length, 0);
  assert.equal(patch.skipped.length, 1);
  assert.match(patch.skipped[0], /wireguard/);
});

ok("垃圾输入不抛异常，返回 ok:false", () => {
  assert.equal(parseSubscription("").ok, false);
  assert.equal(parseSubscription("hello world").ok, false);
  assert.equal(parseSubscription("{ not json").format, "singbox-json");
});

ok("redact 不带出订阅密钥", () => {
  assert.equal(redact("vless://uuid-secret@host:443#x"), "vless://***@host:443#x");
});

ok("tryBase64Text 不误判普通文本", () => {
  assert.equal(tryBase64Text("not base64 at all, has spaces and stuff"), null);
});

process.stdout.write("subscription: " + checks + " checks passed\n");
