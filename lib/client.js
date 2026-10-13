// dsh-model-proxy — 设置卡片（免构建，直接注入宿主 ModuleLoader）
//
// 挂载点：侧栏 插件 → 已安装 → dsh-model-proxy → 行配置。
// key 规则见 ui-plugin-manager 的 rowConfigKey：<包名>#<patch 里声明的行 id>。
// 这里手写而非走打包流程：文件直接以 window.__ModuleLoader__ 载入，
// 不依赖 react/jsx-runtime 的编译期 JSX，用 runtime 的 jsx() 工厂即可。
window.__ModuleLoader__.load({
  id: "dsh-model-proxy",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const { useCallback, useEffect, useMemo, useState } = require("react");
    const { jsx } = require("react/jsx-runtime");

    const BRIDGE = "/api/dsh-model-proxy-settings";

    async function bridgeGet(path) {
      const response = await fetch(`${BRIDGE}${path}`, { method: "GET" });
      return response.json();
    }
    async function bridgePost(path, body) {
      const response = await fetch(`${BRIDGE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      return response.json();
    }

    const COPY = {
      title: "域名代理",
      subtitle: "指定哪些域名走本地代理，未指定的直连。",
      proxyLabel: "本地代理地址",
      proxyHint: "NekoBox 等本地 HTTP 代理的监听地址，例如 http://127.0.0.1:2080。不支持 SOCKS / PAC。",
      enableLabel: "启用代理分流",
      modeLabel: "分流模式",
      modeOff: "关闭（全部直连）",
      modeAllowlist: "白名单：只有列出的域名走代理",
      modeEverything: "全部走代理",
      domainsLabel: "走代理的域名",
      domainsHint: "输入后回车（或点「添加」）即存成上方标签，改动立刻写入配置、无需再点保存。可一次粘多个，空格/逗号/换行分隔。留空 = 白名单模式下不代理任何域名。",
      domainsPlaceholder: "api.openai.com",
      domainsAdd: "添加",
      domainsEmpty: "还没有域名。在下面输入后回车，就会变成上面的标签。",
      removeDomain: "删除该域名",
      domainInvalid: "认不出这是域名：只填主机名，别带 http://、路径或空格",
      domainDuplicate: "已经加过了：",
      domainAdded: "已添加：",
      discoveredLabel: "已发现的域名（点一下加入上面列表）",
      hostsLabel: "实际影响的域名",
      bypassLabel: "永远直连（优先于上面的域名）",
      bypassHint: "一行一个域名模式，如 api.example.com、.example.com、api.example.com:443",
      save: "保存",
      saved: "已保存",
      saving: "保存中…",
      test: "测试",
      testing: "测试中…",
      testResult: "测试结果",
      saveFailed: "保存失败",
      noProviders: "暂未从配置里解析出任何域名。可以直接在上面「走代理的域名」里手填。",
      noHosts:
        "解析不出域名。直接填在「走代理的域名」里即可。",
      active: "已生效",
      inactive: "未生效",
      sharedHostWarn:
        "注意：代理在传输层按域名生效。写 api.example.com 会同时代理该主机上的所有请求。",
    };

    const CSS = `
.mp-card{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#1d1d1f;border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px;min-width:0}
@media (prefers-color-scheme:dark){.mp-card{color:#f5f5f7;border-color:rgba(255,255,255,.1);background:rgba(30,30,32,.5)}}
.mp-row{display:flex;flex-direction:column;gap:6px}
.mp-label{font-size:12px;font-weight:600;opacity:.75}
.mp-hint{font-size:11px;opacity:.6;line-height:1.5}
.mp-input{padding:7px 9px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:13px;font-family:inherit}
.mp-input:focus{outline:2px solid rgba(0,122,255,.5);outline-offset:1px}
.mp-list{display:flex;flex-direction:column;gap:6px;max-height:340px;overflow:auto;padding:2px}
.mp-item{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border-radius:9px;border:1px solid rgba(128,128,128,.22)}
.mp-itemTop{display:flex;align-items:center;gap:8px;cursor:pointer}
.mp-name{font-size:13px;font-weight:600}
.mp-providerId{font-size:11px;opacity:.55;font-family:ui-monospace,monospace}
.mp-hosts{display:flex;flex-wrap:wrap;gap:4px;margin-left:26px}
.mp-host{font-size:10px;font-family:ui-monospace,monospace;padding:1px 6px;border-radius:5px;background:rgba(128,128,128,.16);color:inherit;border:1px solid transparent}
.mp-hostOn{background:rgba(0,122,255,.18);border-color:rgba(0,122,255,.4)}
.mp-hostMuted{font-family:inherit;opacity:.7;background:none;padding:0}
.mp-itemDisabled{opacity:.55}
.mp-itemDisabled .mp-itemTop{cursor:not-allowed}
.mp-warn{font-size:11px;padding:8px 10px;border-radius:8px;background:rgba(255,180,0,.12);border:1px solid rgba(255,180,0,.3);line-height:1.5}
.mp-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mp-btn{padding:6px 14px;border-radius:8px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;font-size:13px;cursor:pointer;font-family:inherit}
.mp-btnPrimary{background:#007aff;border-color:#007aff;color:#fff}
.mp-btn:disabled{opacity:.5;cursor:default}
.mp-status{font-size:11px;opacity:.7;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}
.mp-statusOk{color:#0a7d28}
.mp-statusErr{color:#c5221f}
.mp-textarea{min-height:84px;resize:vertical;line-height:1.6}
.mp-inlineRow{display:flex;gap:6px}
/* 已保存的域名：chip 标签 + 每条一个删除按钮 */
.mp-chips{display:flex;flex-wrap:wrap;gap:6px}
.mp-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 6px 3px 9px;border-radius:7px;background:rgba(0,122,255,.14);border:1px solid rgba(0,122,255,.34);font-family:ui-monospace,monospace;font-size:11px;line-height:1.6}
.mp-chipName{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-chipDel{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:none;border-radius:4px;background:transparent;color:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.6;font-family:inherit}
.mp-chipDel:hover{opacity:1;background:rgba(0,122,255,.22)}
.mp-addRow{display:flex;gap:6px;align-items:center}
.mp-addRow .mp-input{flex:1;min-width:0}
`;

    /**
     * 一次输入可能粘进来多个域名，按空白/逗号/分号拆开。
     * `api.example.com:443` 里没有分隔符，不会被拆坏。
     */
    function splitDomainInput(raw) {
      return String(raw ?? "").split(/[\s,;]+/).filter((part) => part !== "");
    }

    /**
     * 单条域名 → 规范化 host 模式（policy.js 认的形态），不合法返回 null。
     * 客户端 bundle 不能 require 同级 lib 文件（宿主 ModuleLoader 只给 bare
     * specifier，见 dsh-memory-evolve/lib/client.js 只 require react 与
     * @deepseek-ai/dsh-client-ui-primitives），所以这份校验就地写一份。
     */
    function parseDomainEntry(raw) {
      const text = String(raw ?? "").trim().toLowerCase();
      if (text === "") return null;
      if (text === "*") return text;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return null; // 带了 scheme
      if (/[\s/?#@\\]/.test(text)) return null; // 路径 / 账号密码 / 反斜杠
      const matched = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}|\*|any))?$/.exec(text);
      if (matched === null) return null;
      const port = matched[2];
      // :* / :any 表示任意端口（policy.js:hostMatches 认这两种写法）；数字端口要在 1–65535
      if (port !== undefined && port !== "*" && port !== "any") {
        const number = Number(port);
        if (number === 0 || number > 65535) return null;
      }
      const host = matched[1];
      // IPv6 字面量要带方括号（policy.js:hostMatches 两边都会剥），没有点分隔，别走域名那套
      if (host.startsWith("[")) return /^\[[0-9a-f:.]+\]$/.test(host) ? text : null;
      const bare = host.replace(/^\*\./, "").replace(/^\./, "");
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return text; // IPv4
      if (bare === "localhost") return text;
      const label = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
      const parts = bare.split(".");
      if (parts.length < 2 || parts.some((part) => !label.test(part))) return null;
      return text;
    }

    /**
     * 已发现的域名行：显示 provider 名 + 它实际会打到的域名。
     * 点域名 = 加进「走代理的域名」列表。provider 名只是标签，点它会把该供应商
     * 解析出的所有域名一次性加进去（省得逐个点）。
     */
    function renderProviderRow(row, addDomains, listed) {
      const hosts = row.hosts.length > 0
        ? row.hosts.map((host) => jsx("button", {
          key: host,
          type: "button",
          className: listed.has(host) ? "mp-host mp-hostOn" : "mp-host",
          title: listed.has(host) ? "已在列表中" : "加入走代理的域名",
          onClick: () => addDomains([host]),
          children: host,
        }))
        : [jsx("span", { key: "unknown", className: "mp-host mp-hostMuted", children: COPY.noHosts })];
      return jsx("div", {
        key: row.provider,
        className: "mp-item",
        children: [
          jsx("div", {
            className: "mp-itemTop",
            children: [
              jsx("span", {
                className: "mp-name",
                title: row.hosts.length > 0 ? "加入该供应商的所有域名" : undefined,
                style: row.hosts.length > 0 ? { cursor: "pointer" } : undefined,
                onClick: row.hosts.length > 0 ? () => addDomains(row.hosts) : undefined,
                children: row.displayName,
              }),
              jsx("span", { className: "mp-providerId", children: row.provider }),
            ],
          }),
          jsx("div", { className: "mp-hosts", children: hosts }),
        ],
      });
    }

    function ProxyCard(props) {
      const [config, setConfig] = useState(null);
      const [rows, setRows] = useState([]);
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);
      const [saving, setSaving] = useState(false);
      const [savedAt, setSavedAt] = useState(0);
      const [probing, setProbing] = useState(false);
      const [probeResult, setProbeResult] = useState(null);
      const [bypassText, setBypassText] = useState("");

      const refresh = useCallback(async () => {
        const [described, catalog] = await Promise.all([
          bridgeGet("/describe"),
          bridgeGet("/catalog"),
        ]);
        if (described.ok && described.value) {
          setConfig(described.value.config);
          setStatus(described.value.status);
        } else {
          setError(described?.message ?? "无法读取配置");
        }
        if (catalog.ok && catalog.value) setRows(catalog.value.rows ?? []);
      }, []);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      // 配置默认值来自 patch，bypass 要等首次读到才有初值
      useEffect(() => {
        if (config && bypassText === "") setBypassText((config.bypass ?? []).join("\n"));
      }, [config, bypassText]);

      // 域名清单是一份数组，不是 textarea：每个域名一个 chip，点 ✕ 即删。
      // 改动直接写回配置（persistDomains），所以输入即保存，不用再点「保存」。
      const [domains, setDomains] = useState([]);
      const [domainDraft, setDomainDraft] = useState("");
      const [domainNote, setDomainNote] = useState(null);
      const [loaded, setLoaded] = useState(false);
      useEffect(() => {
        if (config !== null && !loaded) {
          setDomains((config.selected ?? []).filter((entry) => typeof entry === "string"));
          setLoaded(true);
        }
      }, [config, loaded]);

      const listed = useMemo(() => new Set(domains), [domains]);

      /**
       * 把域名清单写回配置存储。
       * 只写 selected 一项 —— 其余字段仍由卡片底部的「保存」负责，
       * 这样域名编辑不会顺手覆盖用户正在改的代理地址/开关。
       */
      const persistDomains = useCallback(async (next) => {
        setSaving(true);
        setError(null);
        const result = await bridgePost("/mutate", {
          ns: "model-proxy",
          ops: [{ op: "set", path: ["rules", "selected"], value: next }],
        });
        setSaving(false);
        if (result.ok) {
          setSavedAt(Date.now());
          setStatus(result.value?.status ?? null);
          // describe 回来的 config 才是权威值，别让本地 state 跟它分叉
          const confirmed = result.value?.config?.selected;
          setDomains(Array.isArray(confirmed) ? confirmed : next);
        } else {
          setError(result.message ?? "保存失败");
        }
      }, []);

      /** 追加域名：校验 → 去重 → 立刻落盘。 */
      const addDomains = useCallback(
        (entries, rawInput) => {
          const incoming = (entries ?? []).map(parseDomainEntry);
          const rejected = (entries ?? []).filter((entry, i) => incoming[i] === null);
          const fresh = incoming.filter((entry) => entry !== null && !listed.has(entry));
          const duplicates = incoming.filter((entry) => entry !== null && listed.has(entry));
          if (rejected.length > 0) {
            setDomainNote(`${COPY.domainInvalid}：${rejected.join("、")}`);
          } else if (fresh.length === 0) {
            setDomainNote(duplicates.length > 0 ? `${COPY.domainDuplicate}${duplicates.join("、")}` : null);
          } else {
            const next = [...domains, ...fresh];
            setDomainNote(`${COPY.domainAdded}${fresh.join("、")}`);
            setDomains(next);
            void persistDomains(next);
          }
          // 从「已发现的域名」点进来时没输入框要清；手输时清掉整段（含残留的无效文本）
          if (rawInput === true) setDomainDraft("");
        },
        [domains, listed, persistDomains],
      );

      const removeDomain = useCallback(
        (entry) => {
          const next = domains.filter((item) => item !== entry);
          setDomains(next);
          setDomainNote(null);
          void persistDomains(next);
        },
        [domains, persistDomains],
      );

      const save = useCallback(async () => {
        setSaving(true);
        setError(null);
        const bypass = bypassText.split("\n").map((line) => line.trim()).filter((line) => line !== "");
        const result = await bridgePost("/mutate", {
          ns: "model-proxy",
          ops: [
            { op: "set", path: ["rules", "enabled"], value: config?.enabled === true },
            { op: "set", path: ["rules", "mode"], value: config?.mode ?? "off" },
            { op: "set", path: ["rules", "proxyUrl"], value: config?.proxyUrl ?? "" },
            { op: "set", path: ["rules", "bypass"], value: bypass },
          ],
        });
        setSaving(false);
        if (result.ok) {
          setSavedAt(Date.now());
          setStatus(result.value?.status ?? null);
        } else {
          setError(result.message ?? "保存失败");
        }
      }, [config, bypassText]);

      const submitDraft = useCallback(() => {
        const parts = splitDomainInput(domainDraft);
        if (parts.length === 0) {
          setDomainDraft("");
          return;
        }
        addDomains(parts, true);
      }, [addDomains, domainDraft]);

      const test = useCallback(async () => {
        setProbing(true);
        setProbeResult(null);
        // 探第一个列出的域名；bypass 优先，别探被绕过的那个
        const first = listed.values().next().value;
        if (first === undefined) {
          setProbing(false);
          setProbeResult({ ok: false, message: "域名列表是空的 —— 填一个要走代理的域名再测试。" });
          return;
        }
        const url = first.startsWith("http") ? first : `https://${first}/`;
        const result = await bridgePost("/probe", { url });
        setProbing(false);
        setProbeResult({ ...result, host: first });
      }, [listed]);

      if (config === null) {
        return jsx("div", { className: "mp-card", children: error ?? "加载中…" });
      }

      const checkRow = (label, checked, onChange, hint) =>
        jsx("label", {
          key: label,
          className: "mp-itemTop",
          children: [
            jsx("input", { type: "checkbox", checked, onChange }),
            jsx("span", { className: "mp-name", children: label }),
            hint === undefined ? null : jsx("span", { className: "mp-hint", children: hint }),
          ],
        });

      return jsx("div", { className: "mp-card", children: [
        jsx("style", { key: "css", children: CSS }),
        jsx("div", { key: "head", children: [
          jsx("div", { className: "mp-label", children: COPY.title }),
          jsx("div", { className: "mp-hint", children: COPY.subtitle }),
        ] }),

        checkRow(COPY.enableLabel, config.enabled === true, (event) =>
          setConfig((prev) => ({ ...prev, enabled: event.target.checked }))),

        jsx("div", { key: "mode", className: "mp-row", children: [
          jsx("label", { className: "mp-label", children: COPY.modeLabel }),
          jsx("select", {
            className: "mp-input",
            value: config.mode ?? "off",
            onChange: (event) => setConfig((prev) => ({ ...prev, mode: event.target.value })),
            children: [
              { value: "off", label: COPY.modeOff },
              { value: "allowlist", label: COPY.modeAllowlist },
              { value: "everything", label: COPY.modeEverything },
            ].map((option) => jsx("option", { key: option.value, value: option.value, children: option.label })),
          }),
        ] }),

        jsx("div", { key: "proxy", className: "mp-row", children: [
          jsx("label", { className: "mp-label", children: COPY.proxyLabel }),
          jsx("input", {
            className: "mp-input",
            placeholder: "http://127.0.0.1:2080",
            value: config.proxyUrl ?? "",
            onChange: (event) => setConfig((prev) => ({ ...prev, proxyUrl: event.target.value })),
          }),
          jsx("div", { className: "mp-hint", children: COPY.proxyHint }),
        ] }),

        jsx("div", { key: "domains", className: "mp-row", children: [
          jsx("label", { className: "mp-label", children: COPY.domainsLabel }),
          domains.length === 0
            ? jsx("div", { className: "mp-hint", children: COPY.domainsEmpty })
            : jsx("div", { className: "mp-chips", children: domains.map((entry) =>
                jsx("span", { key: entry, className: "mp-chip", children: [
                  jsx("span", { className: "mp-chipName", children: entry }),
                  jsx("button", {
                    type: "button",
                    className: "mp-chipDel",
                    title: COPY.removeDomain,
                    "aria-label": `${COPY.removeDomain}：${entry}`,
                    onClick: () => removeDomain(entry),
                    children: "✕",
                  }),
                ] })) }),
          jsx("div", { className: "mp-addRow", children: [
            jsx("input", {
              className: "mp-input",
              placeholder: COPY.domainsPlaceholder,
              value: domainDraft,
              onChange: (event) => setDomainDraft(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== "Enter") return;
                event.preventDefault(); // 别顺带提交宿主外层的表单
                submitDraft();
              },
            }),
            jsx("button", {
              type: "button",
              className: "mp-btn",
              disabled: saving || domainDraft.trim() === "",
              onClick: submitDraft,
              children: COPY.domainsAdd,
            }),
          ] }),
          domainNote === null ? null : jsx("div", { className: "mp-hint", children: domainNote }),
          jsx("div", { className: "mp-hint", children: COPY.domainsHint }),
        ] }),

        jsx("div", { key: "providers", className: "mp-row", children: [
          jsx("label", { className: "mp-label", children: COPY.discoveredLabel }),
          rows.length === 0
            ? jsx("div", { className: "mp-hint", children: COPY.noProviders })
            : jsx("div", { className: "mp-list", children: rows.map((row) => renderProviderRow(row, addDomains, listed)) }),
          jsx("div", { className: "mp-warn", children: COPY.sharedHostWarn }),
        ] }),

        jsx("div", { key: "bypass", className: "mp-row", children: [
          jsx("label", { className: "mp-label", children: COPY.bypassLabel }),
          jsx("textarea", {
            className: "mp-input mp-textarea",
            value: bypassText,
            placeholder: "localhost\n.example.com",
            onChange: (event) => setBypassText(event.target.value),
          }),
          jsx("div", { className: "mp-hint", children: COPY.bypassHint }),
        ] }),

        jsx("div", { key: "actions", className: "mp-actions", children: [
          jsx("button", {
            className: "mp-btn mp-btnPrimary",
            type: "button",
            disabled: saving,
            onClick: save,
            children: saving ? COPY.saving : COPY.save,
          }),
          jsx("button", {
            className: "mp-btn",
            type: "button",
            disabled: probing,
            onClick: test,
            children: probing ? COPY.testing : COPY.test,
          }),
          savedAt > 0 ? jsx("span", { className: "mp-status mp-statusOk", children: COPY.saved }) : null,
        ] }),

        status === null ? null : jsx("div", {
          key: "status",
          className: `mp-status ${status.active ? "mp-statusOk" : "mp-statusErr"}`,
          children: status.active
            ? `${COPY.active} · ${status.mode} · ${status.proxyUrl ?? ""}`
            : `${COPY.inactive}${status.reason ? ` · ${status.reason}` : ""}`,
        }),

        probeResult === null ? null : jsx("div", {
          key: "probe",
          className: `mp-status ${probeResult.ok ? "mp-statusOk" : "mp-statusErr"}`,
          children: `${COPY.testResult}: ${probeResult.ok ? `HTTP ${probeResult.status}` : probeResult.message ?? "失败"}`
            + ` · 代理端口 ${probeResult.proxyReachable ? "可连" : `不可达 (${probeResult.proxyError ?? "未知"})`}`,
        }),

        error === null ? null : jsx("div", { key: "error", className: "mp-status mp-statusErr", children: error }),
      ] });
    }

    /** 插件列表页那一行的摘要文字。 */
    function summaryText(state) {
      const rules = state?.rules ?? {};
      if (rules.enabled !== true || rules.mode === "off") return "未启用";
      if (rules.mode === "everything") return `全部走代理 · ${rules.proxyUrl ?? ""}`;
      const count = Array.isArray(rules.selected) ? rules.selected.length : 0;
      return `${count} 个域名走代理 · ${rules.proxyUrl ?? ""}`;
    }

    const inject = ["slots"];

    function apply(ctx) {
      // 侧栏 插件 → 已安装 → dsh-model-proxy → 行配置页。
      // rc.1 之后插件配置只保留 plugins.row.config，不再有独立的设置页 slot。
      ctx.slots.inject("plugins.row.config", () =>
        ctx.slots.register(
          {
            name: "plugins.row.config",
            key: "dsh-model-proxy#model-proxy",
          },
          (slotProps) =>
            slotProps && slotProps.view === "summary"
              ? summaryText(slotProps.state ?? slotProps.config)
              : jsx(ProxyCard, {})
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.ProxyCard = ProxyCard;
    exports.summaryText = summaryText;
    // 导出给 test/client-domains.mjs：域名校验/拆分是这段 UI 里唯一有分支的逻辑。
    exports.splitDomainInput = splitDomainInput;
    exports.parseDomainEntry = parseDomainEntry;
    return module.exports;
  },
});