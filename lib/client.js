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

    const { useCallback, useEffect, useMemo, useRef, useState } = require("react");
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
      // ── 节点管理 ──────────────────────────────────────────────────────────
      nodesLabel: "节点（机场订阅）",
      nodesHint:
        "插件自己不跑协议：VLESS / Hysteria2 由本机内核（mihomo / Clash Verge / sing-box）承载。这里填订阅和内核控制面地址，插件负责解析订阅、测延迟、代理不通时换节点。",
      subLabel: "订阅地址或内容",
      subPlaceholder: "https://example.com/api/v1/client/subscribe?token=…  （也可以直接粘 base64 内容）",
      coreApiLabel: "内核 API 地址",
      coreApiPlaceholder: "http://127.0.0.1:9090",
      coreSecretLabel: "内核 API 密钥（可空）",
      coreGroupLabel: "代理组名",
      nodeAutoLabel: "定时巡检并自动切换节点",
      nodeRead: "读取节点",
      nodeRefresh: "刷新订阅",
      nodeTest: "测速",
      nodeTesting: "测速中…",
      nodeRefreshing: "刷新中…",
      nodeEmpty: "还没有节点。填订阅后点「刷新订阅」，或让内核自己订阅后点「读取节点」。",
      nodeCurrent: "当前",
      nodeSwitch: "切到该节点",
      nodeLatency: "延迟",
      // ── 托管内核 ──────────────────────────────────────────────────────────
      coreLabel: "托管内核（插件自己跑 mihomo）",
      coreHint:
        "打开后插件自己下载并启动 mihomo：出站代理固定走 127.0.0.1:<代理端口>，节点控制面固定走 127.0.0.1:<API 端口>（上面填的代理地址与内核 API 地址不再参与）。下载走插件自己的分流，墙内也能装。",
      coreManagedLabel: "由插件托管内核",
      coreDirLabel: "内核目录",
      coreDirPlaceholder: "留空 = ~/.dsh/dsh-model-proxy-core",
      coreVersionLabel: "指定版本",
      coreVersionPlaceholder: "留空 = 最新（如 v1.19.33）",
      coreApiPortLabel: "API 端口",
      coreMixedPortLabel: "代理端口",
      coreInstall: "安装内核",
      coreInstalling: "下载中…",
      coreCoreStart: "启动内核",
      coreCoreStop: "停止内核",
      coreNotInstalled: "托管目录里还没有内核，点「安装内核」下载。",
      coreRunning: "内核运行中",
      coreStopped: "内核未运行",
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
/* 节点表：名字 + 协议 + 延迟，点行切换 */
.mp-nodeList{display:flex;flex-direction:column;gap:4px;max-height:260px;overflow:auto}
.mp-node{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;border:1px solid rgba(128,128,128,.2);font-size:12px;cursor:pointer;background:transparent;color:inherit;font-family:inherit;text-align:left;width:100%}
.mp-node:hover{background:rgba(128,128,128,.1)}
.mp-nodeOn{border-color:rgba(0,122,255,.6);background:rgba(0,122,255,.12)}
.mp-nodeName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mp-nodeProto{font-size:10px;opacity:.55;font-family:ui-monospace,monospace}
.mp-nodeLat{font-size:11px;font-family:ui-monospace,monospace;opacity:.75}
.mp-nodeBad{color:#c5221f;opacity:.9}
.mp-nodeGood{color:#0a7d28;opacity:.9}
.mp-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}
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
      const [nodeView, setNodeView] = useState(null);
      const [nodeBusy, setNodeBusy] = useState("");
      const [nodeNote, setNodeNote] = useState(null);
      const [coreView, setCoreView] = useState(null);
      const [coreBusy, setCoreBusy] = useState("");
      const [coreNote, setCoreNote] = useState(null);

      const refresh = useCallback(async () => {
        const [described, catalog] = await Promise.all([
          bridgeGet("/describe"),
          bridgeGet("/catalog"),
        ]);
        if (described.ok && described.value) {
          setConfig(described.value.config);
          setStatus(described.value.status);
          // 记下当前 revision：后面每次写都带上它，宿主的乐观锁才真的起作用
          const revision = described.value.descriptor?.revision;
          if (typeof revision === "number") revisionRef.current = revision;
        } else {
          setError(described?.message ?? "无法读取配置");
        }
        if (catalog.ok && catalog.value) setRows(catalog.value.rows ?? []);
        // 节点清单是活的（测速/巡检都会改），失败不算错——没配内核时这里本来就是空
        try {
          const listed = await bridgeGet("/nodes");
          setNodeView(listed.ok ? listed.value : null);
        } catch {
          setNodeView(null);
        }
        // 托管内核状态也是活的（进程可能刚被装/起/停）
        try {
          const coreListed = await bridgeGet("/core");
          setCoreView(coreListed.ok ? coreListed.value : null);
        } catch {
          setCoreView(null);
        }
      }, []);

      useEffect(() => {
        void refresh();
      }, [refresh]);

      // 配置默认值来自 patch，bypass 要等首次读到才有初值。
      // 只在第一次拿到 config 时灌一次：依赖里若带着 bypassText，用户把输入框删空后
      // 这个 effect 会立刻把旧值填回去 —— 也就是 bypass 永远清不空。
      const bypassLoaded = useRef(false);
      useEffect(() => {
        if (config === null || bypassLoaded.current) return;
        bypassLoaded.current = true;
        setBypassText((config.bypass ?? []).join("\n"));
      }, [config]);

      // 域名清单是一份数组，不是 textarea：每个域名一个 chip，点 ✕ 即删。
      // 改动直接写回配置（persistDomains），所以输入即保存，不用再点「保存」。
      const [domains, setDomains] = useState([]);
      const [domainDraft, setDomainDraft] = useState("");
      const [domainNote, setDomainNote] = useState(null);
      const [loaded, setLoaded] = useState(false);
      /**
       * 域名清单存两份：state 负责渲染，ref 负责算下一次的值。
       * 同一个 tick 里连点两个 chip 时，回调闭包里的 `domains` 还是旧值，
       * 两边都算成「旧值 + 自己这一个」，后落盘的把前一次覆盖掉（丢写）。
       * 所以所有计算读 ref（回调进入时同步更新），state 只用于渲染。
       */
      const domainsRef = useRef([]);
      const commitDomains = useCallback((next) => {
        domainsRef.current = next;
        setDomains(next);
      }, []);
      useEffect(() => {
        if (config !== null && !loaded) {
          commitDomains((config.selected ?? []).filter((entry) => typeof entry === "string"));
          setLoaded(true);
        }
      }, [config, loaded, commitDomains]);

      const listed = useMemo(() => new Set(domains), [domains]);

      /**
       * 统一包住对桥的请求：任何 reject（网络抖动、宿主重启、响应不是 JSON）都在这里
       * 折成 setError，绝不冒泡 —— 一次失败不能让按钮永久卡在「保存中…」。
       * 返回解析好的结果对象；null = 已经在界面上报了错，调用方直接收工。
       */
      const postSafely = useCallback(async (path, body) => {
        try {
          return await bridgePost(path, body);
        } catch (error) {
          setError(error?.message ?? "请求失败");
          return null;
        }
      }, []);

      /**
       * 写队列：删一个 chip 的同时又加一个，两个请求并发到后端时到达顺序不保证，
       * 后到的旧值会把新值盖回去。把写串成一条链 —— 每次写的值都是当时最新的整份清单，
       * 链尾即最终意图。`inFlight` 用来让「保存中…」在最后一个请求落地后才解锁。
       */
      const writeChain = useRef(Promise.resolve());
      const inFlight = useRef(0);

      /**
       * /describe 回来的 revision。宿主 settings.mutate 的乐观锁只在传了 expectedRevision
       * 时才生效；不传的话两个窗口、两次写就会静默互相覆盖（等下一次读配置才发现被吞）。
       */
      const revisionRef = useRef(null);

      /** 写请求统一带上已知的 revision。 */
      const mutateBody = useCallback((ops) => {
        const body = { ns: "model-proxy", ops };
        if (typeof revisionRef.current === "number") body.expectedRevision = revisionRef.current;
        return body;
      }, []);

      /**
       * 写结果收口：成功就记下新 revision 并刷新状态；被拒（revision 冲突、校验失败）就
       * 报错并重新拉一次权威值 —— 别让界面继续停在一个后端并不接受的配置上。
       */
      const absorbResult = useCallback(
        (result) => {
          if (result === null) return null;
          if (result.ok) {
            setSavedAt(Date.now());
            setStatus(result.value?.status ?? null);
            const nextRevision = result.value?.descriptor?.revision;
            if (typeof nextRevision === "number") revisionRef.current = nextRevision;
            return result.value;
          }
          setError(result.message ?? "保存失败");
          void refresh();
          return null;
        },
        [refresh],
      );

      /**
       * 把域名清单写回配置存储。
       * 只写 selected 一项 —— 其余字段仍由卡片底部的「保存」负责，
       * 这样域名编辑不会顺手覆盖用户正在改的代理地址/开关。
       */
      const persistDomains = useCallback(
        (next) => {
          inFlight.current += 1;
          setSaving(true);
          setError(null);
          const run = writeChain.current.then(async () => {
            const result = await postSafely(
              "/mutate",
              mutateBody([{ op: "set", path: ["rules", "selected"], value: next }]),
            );
            if (result === null) return;
            const value = absorbResult(result);
            if (value === null) return;
            // describe 回来的 config 才是权威值，别让本地 state 跟它分叉
            const confirmed = value.config?.selected;
            commitDomains(Array.isArray(confirmed) ? confirmed : next);
          });
          // 链本身不能被某一次失败卡住（postSafely 已把 reject 折成 null，这里是兜底）
          const settled = run.catch(() => {});
          writeChain.current = settled;
          return settled.finally(() => {
            inFlight.current -= 1;
            if (inFlight.current === 0) setSaving(false);
          });
        },
        [postSafely, commitDomains, mutateBody, absorbResult],
      );

      /** 追加域名：校验 → 去重 → 立刻落盘。整段读 ref，不读闭包里的 state。 */
      const addDomains = useCallback(
        (entries, rawInput) => {
          const present = new Set(domainsRef.current);
          const incoming = (entries ?? []).map(parseDomainEntry);
          const rejected = (entries ?? []).filter((entry, i) => incoming[i] === null);
          const fresh = [];
          const duplicates = [];
          for (const entry of incoming) {
            if (entry === null) continue;
            if (present.has(entry)) {
              duplicates.push(entry);
              continue;
            }
            present.add(entry); // 同一批里重复的也只收一次
            fresh.push(entry);
          }
          if (rejected.length > 0) {
            setDomainNote(`${COPY.domainInvalid}：${rejected.join("、")}`);
          } else if (fresh.length === 0) {
            setDomainNote(duplicates.length > 0 ? `${COPY.domainDuplicate}${duplicates.join("、")}` : null);
          } else {
            const next = [...domainsRef.current, ...fresh];
            setDomainNote(`${COPY.domainAdded}${fresh.join("、")}`);
            commitDomains(next);
            void persistDomains(next);
          }
          // 从「已发现的域名」点进来时没输入框要清；手输时清掉整段（含残留的无效文本）
          if (rawInput === true) setDomainDraft("");
        },
        [commitDomains, persistDomains],
      );

      const removeDomain = useCallback(
        (entry) => {
          const next = domainsRef.current.filter((item) => item !== entry);
          commitDomains(next);
          setDomainNote(null);
          void persistDomains(next);
        },
        [commitDomains, persistDomains],
      );

      const save = useCallback(async () => {
        setSaving(true);
        setError(null);
        try {
          const bypass = bypassText.split("\n").map((line) => line.trim()).filter((line) => line !== "");
          const result = await postSafely(
            "/mutate",
            mutateBody([
              { op: "set", path: ["rules", "enabled"], value: config?.enabled === true },
              { op: "set", path: ["rules", "mode"], value: config?.mode ?? "off" },
              { op: "set", path: ["rules", "proxyUrl"], value: config?.proxyUrl ?? "" },
              { op: "set", path: ["rules", "bypass"], value: bypass },
              { op: "set", path: ["rules", "subscription"], value: config?.subscription ?? "" },
              { op: "set", path: ["rules", "coreApi"], value: config?.coreApi ?? "" },
              { op: "set", path: ["rules", "coreSecret"], value: config?.coreSecret ?? "" },
              { op: "set", path: ["rules", "coreGroup"], value: config?.coreGroup ?? "DSH" },
              { op: "set", path: ["rules", "nodesAuto"], value: config?.nodesAuto === true },
            ]),
          );
          absorbResult(result);
        } finally {
          setSaving(false);
        }
      }, [config, bypassText, postSafely, mutateBody, absorbResult]);

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
        try {
          // 探第一个列出的域名；bypass 优先，别探被绕过的那个
          const first = listed.values().next().value;
          if (first === undefined) {
            setProbeResult({ ok: false, message: "域名列表是空的 —— 填一个要走代理的域名再测试。" });
            return;
          }
          const url = first.startsWith("http") ? first : `https://${first}/`;
          const result = await postSafely("/probe", { url });
          if (result === null) {
            setProbeResult({ ok: false, message: "测试请求没能送到插件后端（详见上方错误）。", host: first });
            return;
          }
          setProbeResult({ ...result, host: first });
        } finally {
          setProbing(false);
        }
      }, [listed, postSafely]);

      /**
       * 节点相关的三种动作（读/刷新/测速）+ 手动切换，共用一个 busy 标记。
       * 统一把结果里的 snapshot 灌进 nodeView —— 后端已经排好序（可用、延迟低在前）。
       */
      const applyNodeResult = useCallback((result, label) => {
        if (result === null) {
          setNodeNote(label + "：请求没送到插件后端");
          return;
        }
        if (!result.ok) {
          setNodeNote(label + "：" + (result.message ?? "失败"));
          const partial = result.value?.snapshot;
          if (partial !== undefined) setNodeView(partial);
          return;
        }
        const value = result.value ?? {};
        const snapshot = value.snapshot ?? (Array.isArray(value.nodes) ? value : null);
        if (snapshot !== null) setNodeView(snapshot);
        const parts = [label + "：成功"];
        if (typeof value.nodes === "number") parts.push(value.nodes + " 个节点");
        if (typeof value.parsed === "number") parts.push("解析 " + value.parsed + " 个");
        if (Array.isArray(value.skipped) && value.skipped.length > 0) parts.push("跳过 " + value.skipped.length + " 个不支持导入的协议");
        if (Array.isArray(value.warnings) && value.warnings.length > 0) parts.push(value.warnings[0]);
        if (Array.isArray(value.results)) {
          const good = value.results.filter((item) => item.ok).length;
          parts.push("可用 " + good + "/" + value.results.length);
        }
        setNodeNote(parts.join("；"));
      }, []);

      const nodeAction = useCallback(async (kind, label, run) => {
        if (nodeBusy !== "") return;
        setNodeBusy(kind);
        setNodeNote(null);
        try {
          applyNodeResult(await run(), label);
        } finally {
          setNodeBusy("");
        }
      }, [applyNodeResult, nodeBusy]);

      const readNodes = useCallback(() => nodeAction("read", COPY.nodeRead, async () => {
        try {
          return await bridgeGet("/nodes");
        } catch (error) {
          return { ok: false, message: error?.message ?? "请求失败" };
        }
      }), [nodeAction]);

      const refreshSubscription = useCallback(() => nodeAction("refresh", COPY.nodeRefresh, async () => {
        // 先把订阅地址存下来，再让后端用它去拉——否则刷新用的是磁盘上的旧值
        const saved = await postSafely("/mutate", mutateBody([
          { op: "set", path: ["rules", "subscription"], value: config?.subscription ?? "" },
          { op: "set", path: ["rules", "coreApi"], value: config?.coreApi ?? "" },
          { op: "set", path: ["rules", "coreSecret"], value: config?.coreSecret ?? "" },
          { op: "set", path: ["rules", "coreGroup"], value: config?.coreGroup ?? "DSH" },
        ]));
        if (saved === null) return { ok: false, message: "保存订阅设置失败" };
        absorbResult(saved);
        return await postSafely("/nodes/refresh", {});
      }), [nodeAction, postSafely, mutateBody, absorbResult, config]);

      const testNodes = useCallback(() => nodeAction("test", COPY.nodeTest, async () =>
        await postSafely("/nodes/test", {})), [nodeAction, postSafely]);

      const switchNode = useCallback(async (name) => {
        if (nodeBusy !== "") return;
        setNodeBusy("select");
        setNodeNote(null);
        try {
          applyNodeResult(await postSafely("/nodes/select", { name }), "切换");
        } finally {
          setNodeBusy("");
        }
      }, [applyNodeResult, nodeBusy, postSafely]);

      const refreshCore = useCallback(async () => {
        try {
          const listed = await bridgeGet("/core");
          setCoreView(listed.ok ? listed.value : null);
        } catch {
          setCoreView(null);
        }
      }, []);

      const coreAction = useCallback(async (kind, label, run) => {
        if (coreBusy !== "") return;
        setCoreBusy(kind);
        setCoreNote(null);
        try {
          const result = await run();
          if (result === null) return;
          if (!result.ok) {
            setCoreNote(label + "：" + (result.message ?? "失败"));
            return;
          }
          setCoreNote(label + "：成功");
        } finally {
          setCoreBusy("");
          void refreshCore();
        }
      }, [coreBusy, refreshCore]);

      // 安装用的目录/版本来自输入框，所以先存配置再让后端去下载
      const saveCoreSettings = useCallback(async () => {
        const saved = await postSafely("/mutate", mutateBody([
          { op: "set", path: ["rules", "coreManaged"], value: config?.coreManaged === true },
          { op: "set", path: ["rules", "coreDir"], value: config?.coreDir ?? "" },
          { op: "set", path: ["rules", "coreVersion"], value: config?.coreVersion ?? "" },
          { op: "set", path: ["rules", "coreApiPort"], value: Number(config?.coreApiPort ?? 9090) },
          { op: "set", path: ["rules", "coreMixedPort"], value: Number(config?.coreMixedPort ?? 2081) },
        ]));
        if (saved === null) return false;
        absorbResult(saved);
        return true;
      }, [absorbResult, config, mutateBody, postSafely]);

      const installCore = useCallback(() => coreAction("install", COPY.coreInstall, async () => {
        if (!(await saveCoreSettings())) return null;
        return await postSafely("/core/install", {});
      }), [coreAction, postSafely, saveCoreSettings]);

      const startCore = useCallback(() => coreAction("start", COPY.coreCoreStart, async () => {
        if (!(await saveCoreSettings())) return null;
        return await postSafely("/core/start", {});
      }), [coreAction, postSafely, saveCoreSettings]);

      const stopCore = useCallback(() => coreAction("stop", COPY.coreCoreStop, async () =>
        await postSafely("/core/stop", {})), [coreAction, postSafely]);

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

      const nodePanel = nodeView === null || !Array.isArray(nodeView.nodes) || nodeView.nodes.length === 0
        ? jsx("div", { className: "mp-hint", children: COPY.nodeEmpty })
        : jsx("div", {
          className: "mp-nodeList",
          children: nodeView.nodes.map((node) => jsx("button", {
            key: node.name,
            type: "button",
            className: node.name === nodeView.current ? "mp-node mp-nodeOn" : "mp-node",
            title: node.name === nodeView.current ? COPY.nodeCurrent : COPY.nodeSwitch,
            disabled: nodeBusy !== "",
            onClick: () => void switchNode(node.name),
            children: [
              jsx("span", { className: "mp-nodeName", children: node.name }),
              node.protocol === "" ? null : jsx("span", { className: "mp-nodeProto", children: node.protocol }),
              node.latencyMs === null ? null : jsx("span", {
                className: node.ok === false ? "mp-nodeLat mp-nodeBad" : "mp-nodeLat mp-nodeGood",
                children: node.latencyMs + "ms",
              }),
              node.name === nodeView.current ? jsx("span", { className: "mp-nodeProto", children: COPY.nodeCurrent }) : null,
            ],
          })),
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

        jsx("div", { key: "nodes", className: "mp-row", children: [
          jsx("label", { className: "mp-label", children: COPY.nodesLabel }),
          jsx("input", {
            className: "mp-input",
            placeholder: COPY.subPlaceholder,
            value: config.subscription ?? "",
            onChange: (event) => setConfig((prev) => ({ ...prev, subscription: event.target.value })),
          }),
          jsx("div", { className: "mp-grid2", children: [
            jsx("input", {
              className: "mp-input",
              placeholder: COPY.coreApiPlaceholder,
              value: config.coreApi ?? "",
              onChange: (event) => setConfig((prev) => ({ ...prev, coreApi: event.target.value })),
            }),
            jsx("input", {
              className: "mp-input",
              placeholder: COPY.coreGroupLabel,
              value: config.coreGroup ?? "DSH",
              onChange: (event) => setConfig((prev) => ({ ...prev, coreGroup: event.target.value })),
            }),
          ] }),
          jsx("input", {
            className: "mp-input",
            type: "password",
            placeholder: COPY.coreSecretLabel,
            value: config.coreSecret ?? "",
            onChange: (event) => setConfig((prev) => ({ ...prev, coreSecret: event.target.value })),
          }),
          checkRow(COPY.nodeAutoLabel, config.nodesAuto === true, (event) =>
            setConfig((prev) => ({ ...prev, nodesAuto: event.target.checked }))),
          jsx("div", { className: "mp-actions", children: [
            jsx("button", {
              className: "mp-btn",
              type: "button",
              disabled: nodeBusy !== "",
              onClick: readNodes,
              children: nodeBusy === "read" ? COPY.nodeTesting : COPY.nodeRead,
            }),
            jsx("button", {
              className: "mp-btn",
              type: "button",
              disabled: nodeBusy !== "",
              onClick: refreshSubscription,
              children: nodeBusy === "refresh" ? COPY.nodeRefreshing : COPY.nodeRefresh,
            }),
            jsx("button", {
              className: "mp-btn",
              type: "button",
              disabled: nodeBusy !== "",
              onClick: testNodes,
              children: nodeBusy === "test" ? COPY.nodeTesting : COPY.nodeTest,
            }),
          ] }),
          nodePanel,
          nodeNote === null ? null : jsx("div", { className: "mp-hint", children: nodeNote }),
          jsx("div", { className: "mp-hint", children: COPY.nodesHint }),
        ] }),

        jsx("div", { key: "core", className: "mp-row", children: [
          jsx("label", { className: "mp-label", children: COPY.coreLabel }),
          checkRow(COPY.coreManagedLabel, config.coreManaged === true, (event) =>
            setConfig((prev) => ({ ...prev, coreManaged: event.target.checked }))),
          jsx("div", { className: "mp-grid2", children: [
            jsx("input", {
              className: "mp-input",
              placeholder: COPY.coreDirPlaceholder,
              value: config.coreDir ?? "",
              onChange: (event) => setConfig((prev) => ({ ...prev, coreDir: event.target.value })),
            }),
            jsx("input", {
              className: "mp-input",
              placeholder: COPY.coreVersionPlaceholder,
              value: config.coreVersion ?? "",
              onChange: (event) => setConfig((prev) => ({ ...prev, coreVersion: event.target.value })),
            }),
          ] }),
          jsx("div", { className: "mp-grid2", children: [
            jsx("input", {
              className: "mp-input",
              type: "number",
              min: 1,
              max: 65535,
              title: COPY.coreApiPortLabel,
              placeholder: COPY.coreApiPortLabel,
              value: String(config.coreApiPort ?? 9090),
              onChange: (event) => setConfig((prev) => ({ ...prev, coreApiPort: Number(event.target.value) || 9090 })),
            }),
            jsx("input", {
              className: "mp-input",
              type: "number",
              min: 1,
              max: 65535,
              title: COPY.coreMixedPortLabel,
              placeholder: COPY.coreMixedPortLabel,
              value: String(config.coreMixedPort ?? 2081),
              onChange: (event) => setConfig((prev) => ({ ...prev, coreMixedPort: Number(event.target.value) || 2081 })),
            }),
          ] }),
          jsx("div", { className: "mp-actions", children: [
            jsx("button", {
              className: "mp-btn",
              type: "button",
              disabled: coreBusy !== "",
              onClick: installCore,
              children: coreBusy === "install" ? COPY.coreInstalling : COPY.coreInstall,
            }),
            jsx("button", {
              className: "mp-btn",
              type: "button",
              disabled: coreBusy !== "",
              onClick: startCore,
              children: COPY.coreCoreStart,
            }),
            jsx("button", {
              className: "mp-btn",
              type: "button",
              disabled: coreBusy !== "",
              onClick: stopCore,
              children: COPY.coreCoreStop,
            }),
          ] }),
          coreView === null
            ? null
            : jsx("div", {
              className: coreView.process?.running ? "mp-status mp-statusOk" : "mp-status",
              children: [
                coreView.binary?.ok === false
                  ? COPY.coreNotInstalled
                  : (coreView.process?.running ? COPY.coreRunning : COPY.coreStopped)
                    + ` · ${coreView.process?.version ?? ""} pid ${coreView.process?.pid ?? "-"} · api ${coreView.api} · proxy ${coreView.proxy} · ${coreView.nodes} 个节点`,
                coreView.process?.lastError ? " · " + coreView.process.lastError : "",
              ].join(""),
            }),
          coreNote === null ? null : jsx("div", { className: "mp-hint", children: coreNote }),
          jsx("div", { className: "mp-hint", children: COPY.coreHint }),
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