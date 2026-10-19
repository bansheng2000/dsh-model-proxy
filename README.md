# dsh-model-proxy

在 DSH 设置里填一批**域名**，这些域名的出站走本地代理（NekoBox / Clash 的
HTTP 混合端口），没填的直连。

面向的场景：你开着本地 HTTP 代理，只有部分站点（比如 `api.openai.com`、
`openrouter.ai`）需要翻墙，其余（DeepSeek 官方、本地 sidecar 等）应该直连——
既省得把所有流量都塞进代理，也避免本机服务绕一圈代理再回来。

```
填写的域名  →  本地代理（http://127.0.0.1:2080）  →  目标 API
未填写的    →  直连                                →  目标 API
回环地址    →  恒直连（DSH 自己的 web server 和代理自身不能进代理）
```

安装后默认**不改变任何现有行为**：`enabled: false` + `mode: off`，必须自己填
代理地址和域名才会接管出站。

## 安装

### 从 GitHub 装（推荐）

仓库：<https://github.com/bansheng2000/dsh-model-proxy>

**1) 登记**。profile 目录是 `%USERPROFILE%\.dsh\profiles\<profile名>`（桌面版默认
`desktop`）。改它的 `package.json`——`dsh.profile.bundles` 是**数组**，不登记的话
插件管理器 UI 列不出来：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // 保留已有的，追加一行
        "dsh-model-proxy"
      ]
    }
  },
  "dependencies": {
    // 二选一，都实测可用：
    "dsh-model-proxy": "https://codeload.github.com/bansheng2000/dsh-model-proxy/tar.gz/refs/tags/v0.2.5"
    // "dsh-model-proxy": "git+https://github.com/bansheng2000/dsh-model-proxy.git"
  }
}
```

> **别用 `github:bansheng2000/dsh-model-proxy` 这种简写。** pnpm 解析简写时会去
> `git ls-remote git+ssh://git@github.com/...`，没配 GitHub SSH key 的机器直接
> 失败（本机实测）。显式写 `git+https://` 或 codeload tarball 地址都不碰 ssh。
> 非要让简写跑通，就把它也重写到 https（注意 `git@github.com:` 形态的
> `insteadOf` 覆盖不到 `git+ssh://`）：
>
> ```powershell
> git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"
> ```

**2) 安装**（github.com 直连不通就先给 pnpm 一个本地代理）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
$env:HTTPS_PROXY = 'http://127.0.0.1:2080'
$dsh = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
node "$dsh\node\bin\node.exe" "$dsh\pnpm\bin\pnpm.cjs" install
```

**3) 追加 patch**，然后在 profile 的 `cordis.patch.yml` 里加上本包自带的 patch：

```yaml
- id: model-proxy
  name: dsh-model-proxy
  config:
    rules:
      enabled: false
      mode: "off"
      proxyUrl: "http://127.0.0.1:2080"
      selected: []
      bypass:
        - localhost
```

重启 DSH（改的是 `lib/` 才需要重启；只改设置页里的域名不用）。

### 手动装（不联网 / 改代码调试）

把 `dsh-model-proxy/` 整份拷进 profile 的 `node_modules/`，再照上面第 1、3 步登记
`dependencies`、`dsh.profile.bundles` 和 patch 即可。注意 profile 里是**真实拷贝**
不是 symlink：改了仓库里的文件必须重新拷贝才会生效。

## 使用

侧栏 **插件 → 已安装 → dsh-model-proxy → 行配置**：

1. 填**本地代理地址**，例如 `http://127.0.0.1:2080`（漏掉 `http://` 会自动补）。
2. 勾**启用代理分流**，**分流模式**选「白名单」。
3. 在**走代理的域名**的输入框里输入域名，**回车**（或点「添加」）即存成上方的
   标签并立刻写入配置 —— 不需要再点保存。每个标签右边有 **✕**，点它就删掉该域名。
   可以一次粘多个（空格 / 逗号 / 换行分隔），重复的会自动去重。例如：

   ```
   api.openai.com
   .anthropic.com
   *.openrouter.ai
   api.example.com:443
   ```

4. 下方**已发现的域名**是从当前 profile 的 provider 配置里解析出来的，点一下就
   加进上面的列表（省得查文档；点 provider 名一次加全部）。
5. **保存**只需管代理地址 / 开关 / 绕过清单这几项。设置即时生效，不需要重启 DSH。
6. 点**测试**可以确认代理端口在监听、目标地址可达。

## 配置项

全部字段在 `rules` 节点下（结构见 `cordis.patch.yml`）：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关。关闭时插件完全不动出站行为 |
| `mode` | `off` / `allowlist`（白名单）/ `everything`（全部走代理） |
| `proxyUrl` | 本地代理地址。仅支持 `http://` / `https://` |
| `selected` | 要走代理的域名清单，一行一个 host 模式 |
| `bypass` | 永远直连的域名，**优先于** `selected` |

`selected` / `bypass` 的域名写法：

- `api.example.com` —— 精确匹配（大小写不敏感）
- `.example.com` / `*.example.com` —— 本域及其子域
- `api.example.com:443` —— 指定端口；`:*` 或 `:any` 表示任意端口
- `*` —— 全部主机

## 代理不通时自动直连

命中的域名先走代理；**在响应交付之前**连不上代理时，插件自动把**同一次调用**改成直连重发。
业务方看不到失败，只是晚一点拿到正常响应。同一次调用最多两次尝试（代理一次、直连一次），
不会并发重发，也不会在直连之后再回头试代理。

代价要说清：若代理其实已经把请求转发出去、只是没把响应头返回来，直连重发会让上游收到
两次——和任何 HTTP 重试同一前提。幂等的读请求无所谓，非幂等的写请求请留意这一点。

切换条件（任一成立即切换）：

| 条件 | 阈值 |
| --- | --- |
| 连接类错误且尚未收到响应头 | `ECONNREFUSED` `ECONNRESET` `ECONNABORTED` `ENOTFOUND` `EAI_AGAIN` `EHOSTUNREACH` `ENETUNREACH` `ETIMEDOUT` `UND_ERR_CONNECT_TIMEOUT` `UND_ERR_SOCKET` |
| 连代理本身超时 | 3000 ms |
| 发出后一直没有响应头 | 5000 ms |

响应头已经到达之后才断的（下载中被掐断）**不切换**——那时已交付一半，重发会重复副作用。

失败一次即进入 down：15 s 内所有请求直接直连，不再撞代理；到期后只放一个请求去试探，
成功则恢复，失败则冷却翻倍（15 s → 30 s → … → 封顶 300 s）。

```
model-proxy: failover fallback — 代理不可用，改直连: ECONNREFUSED
model-proxy: failover recovered — 代理恢复，重新走 127.0.0.1:2080
```

最近 20 条事件与当前状态在设置桥 `getStatus` 的 `failover` 字段（state / failures /
retries / lastError / nextCooldownMs），DSH 日志里同时有 `model-proxy: failover` 行。

**已知边界**：明文 `http://` 目标经 HTTP 代理时，`ProxyAgent` 在「连上代理」那一刻就算
connected（它把请求行改写成绝对 URL 直发），超时看门狗会被提前关掉——这种情况只靠连接
错误切换。HTTPS 目标走 CONNECT 隧道，判定是准的。

## 已知限制（都是传输层的物理限制，不是没实现）

**代理按域名生效，不按单个模型生效。** DSH 的 LLM adapter 自己用
`globalThis.fetch` 发请求，`llm` 服务没有 per-request dispatcher 或 fetch 注入点，
`agent/request` 能改写的调用配置里也没有 baseURL。唯一可编程的介入点是 undici 的
全局 dispatcher，而它只按 origin（`host:port`）决策。所以填 `api.example.com`
会同时代理该主机上的所有请求。界面里有对应提示。

**不支持 SOCKS / PAC，也不读系统代理设置。** undici 的 `ProxyAgent` 只支持 HTTP
代理。NekoBox 的 HTTP 混合端口可以直接用；如果你只开了 SOCKS 端口，需要在
NekoBox 里改成 mixed/http 端口。

**不设自定义 CA。** 代理地址走 HTTP 时不受影响；若要用 HTTPS 代理并自签 CA，
需要在启动 DSH 前设好 `NODE_EXTRA_CA_CERTS`。

**回环地址恒直连。** 本机地址永远不进代理——否则 DSH 自己的 web server 和代理
自身会被送进代理，直接死锁。**这条也让 `opencode2dsh` 这类本地 sidecar 供应商
天然不需要代理**：它的 provider 端点就是本机端口。sidecar 自己再往上游供应商发出的
请求发生在那个独立进程里，要代理得在进程层面设，不在本插件管辖范围。

**插件模块改动必须重启 DSH 才生效。** DSH 把 `lib/*.js` 缓存在 Node ESM 注册表里，
`app-boot/config-reload` 只 reconcile patch/config；插件管理器的停用/启用只重建
plugin fiber 并复用缓存模块，不重新 import。所以改完 `lib/*.js` 要
`Copy-Item` 到 profile 的 `node_modules/` 再重启。

**解析不出主机的域名不能点。** 这些域名点一下也不会有任何流量被代理，所以界面里
直接禁用并提示改用手填。

**空列表即直连。** 白名单模式下没填任何域名时插件保持直连，不会误伤全部流量。

## 自检

```bash
node test/selftest.mjs         # 纯逻辑断言 + 假代理实跑
node test/client-domains.mjs   # 设置卡片域名输入的校验、去重、多值拆分
node test/catalog-offline.mjs  # 设置桥的 catalog 处理器，含 llm 缺席/抛错的降级
node test/failover.mjs         # 死代理（127.0.0.1:1）→ 自动改直连
node test/failover-timeout.mjs # 不可路由代理（192.0.2.1）→ 连接超时后改直连
node test/live-proxy.mjs       # 打真实 NekoBox 的端到端实测
```

`selftest.mjs` 覆盖 host 匹配、白名单/全量/绕过三种模式、provider→host 映射，以及
**实跑验证**：起一个假代理和一个绑在局域网地址上的 origin，实测「填写的域名确实
到达了代理、没填的确实没到、卸载后恢复直连」。实跑部分需要一个可绑定的非回环
本机地址，默认取 `192.168.193.200`，可用环境变量 `SELFTEST_LAN_IP` 指定其他地址；
绑不上就跳过实跑部分（会打印提示），纯逻辑断言照跑。

`live-proxy.mjs` 面向真实环境，代理地址默认 `http://127.0.0.1:2080`
（`SELFTEST_PROXY_URL` 可覆盖）。它先在 `everything` 模式下确认 NekoBox 通、记下
代理出口 IP，再切到 `allowlist` 验证：

- 填写的域名被判定为走代理，且真的收到 HTTP 响应
- 没填的域名被判定为直连（本机需翻墙时应以 `UND_ERR_CONNECT_TIMEOUT` 失败）
- `disposeProxyPlan()` 之后不再经过代理

**判定信号取自 dispatcher 的 `onDecision` 回调，不是出口 IP。** 原因：探测出口 IP
的请求本身也要过一次判定，在白名单下它会直连然后超时，反而掩盖真实结果。代理不通
时脚本以退出码 2 退出，不产生假阳性。

## 文件

- `lib/policy.js` —— 纯函数路由策略：host 模式匹配、域名归一化、代理地址校验
- `lib/providers.js` —— provider → 出站域名映射（配置声明 + 出厂常量兜底，仅供界面「已发现」列表）
- `lib/dispatcher.js` —— undici `Agent({factory})` 的安装 / 热更新 / 释放，以及代理失败降级直连（`Router` + 状态机）
- `lib/bridge.js` —— 设置桥的 HTTP 路由（只接受回环来源）
- `lib/index.js` —— 插件入口：配置 schema、热更新接线、探针
- `lib/client.js` —— 设置卡片（免构建，直接注入宿主 `ModuleLoader`）
- `test/` —— 自检脚本，见上
