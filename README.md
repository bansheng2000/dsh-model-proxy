# dsh-model-proxy

给 DSH 的出站流量按**域名**分流：命中的走代理，其余直连。代理出口二选一——
**本地代理**（NekoBox / Clash 的 HTTP 混合端口），或者**订阅代理**（插件自己
下载并托管 mihomo / sing-box 内核，粘机场订阅就能用）。

面向的场景：你开着本地代理，但只有部分站点（`api.openai.com`、`openrouter.ai`…）
需要翻墙，其余（DeepSeek 官方、本地 sidecar 等）应该直连——既不用把所有流量都塞进
代理，也避免本机服务绕一圈代理再回来。

```
填写的域名  →  本地代理 / 托管内核（mihomo、sing-box）  →  目标 API
未填写的    →  直连                                     →  目标 API
回环地址    →  恒直连（DSH 自己的 web server 和代理自身不能进代理）
```

## 能做什么

| 能力 | 说明 |
| --- | --- |
| 按域名分流 | 白名单 / 全量 / 关闭三种模式；`bypass` 优先于白名单；支持 `host`、`.domain`、`*.domain`、`host:port` |
| 已发现域名 | 从当前 profile 的 provider 配置解析出真实出站域名，点一下加进清单（provider 名点一次加全部） |
| 代理不通自动直连 | 响应交付前连不上代理，就把**同一次调用**改直连重发，业务方无感；随后冷却并自动试探恢复 |
| 订阅代理 | 粘订阅地址或整段订阅内容，自动判别 Clash YAML / sing-box JSON / 分享链接，测延迟、切节点 |
| 自动切节点 | 代理不通、或当前节点连续两次测不出延迟时，自动换到延迟最低的可用节点（带限流防抖） |
| 托管内核 | 一键下载并启动 mihomo 或 sing-box（两者可共存、切换重启），出站与控制面端口自动分配 |
| 分项自检 | 卡片里点「测试」逐行给结果：代理端口是否在监听、目标是否可达，各带耗时与可判定的失败原因 |

安装后默认**不改变任何现有行为**：`enabled: false` + `mode: off`，必须自己启用
并填代理地址与域名才会接管出站。

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
    "dsh-model-proxy": "https://codeload.github.com/bansheng2000/dsh-model-proxy/tar.gz/refs/tags/v0.3.0"
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

1. 先选**代理出口**：**本地代理**（填你自己的代理端口，如 NekoBox 的 2080）或
   **订阅代理**（插件自己装 mihomo + 拉机场订阅，见「托管内核」）。选中的那块展开，
   另一块只留标题、内容隐藏。
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
7. 想让插件自己管内核（省得装 NekoBox/Clash）：选「订阅代理」→ 选 **mihomo** 或
   **sing-box** → 点**启用 / 更新订阅**（缺的内核会一起下好），见「托管内核」一节。

## 配置项

全部字段在 `rules` 节点下（结构见 `cordis.patch.yml`）：

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关。关闭时插件完全不动出站行为 |
| `mode` | `off` / `allowlist`（白名单）/ `everything`（全部走代理） |
| `proxyUrl` | 本地代理地址。仅支持 `http://` / `https://` |
| `selected` | 要走代理的域名清单，一行一个 host 模式 |
| `bypass` | 永远直连的域名，**优先于** `selected` |
| `subscription` | 订阅地址，或者直接粘订阅内容（见「节点订阅与自动切换」）|
| `coreApi` | 内核的 Clash API 地址，如 `127.0.0.1:9090`（只允许回环）|
| `coreSecret` | 内核 API 的 secret，没设就留空 |
| `coreGroup` | 插件读写的策略组名，默认 `DSH` |
| `proxySource` | 代理出口二选一：`local`（本地代理地址）/ `subscription`（订阅 + 托管内核）。选 `subscription` 等价于打开 `coreManaged` |
| `nodesAuto` | 代理不通时自动切到可用节点，默认关 |
| `coreManaged` | 由插件托管 mihomo 内核（自动下载/启动/停止），默认关；打开后忽略 `proxyUrl` 与 `coreApi` |
| `coreDir` | 内核目录，留空 = `~/.dsh/dsh-model-proxy-core` |
| `coreVersion` | 指定内核版本（如 `v1.19.33`），留空 = 最新 |
| `coreApiPort` | 托管内核的 Clash API 端口，默认 `9090` |
| `coreMixedPort` | 托管内核的代理端口，默认 `2081` |
| `coreKind` | 用哪个内核：`mihomo`（默认）/ `singbox`。两个可以同时装着，切换会重启内核 |

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

## 节点订阅与自动切换

插件在这里只做**控制面**：它不自己跑 VLESS / Hysteria2 —— 这两个是传输协议，undici 的
`ProxyAgent` 只会说 HTTP 代理。真正跑节点的是本机内核（mihomo / Clash Meta / sing-box
1.11+），插件通过它的 Clash 兼容 REST API 做三件事：拉订阅导入节点、测延迟、切节点。

前提：内核开了 `external-controller`（例如 `external-controller: 127.0.0.1:9090`）。
NekoBox / v2rayN 没有这个 API，用不了这一节；换 mihomo 内核或 sing-box 即可。

### 四个动作

| 动作 | 走哪条路 | 说明 |
| --- | --- | --- |
| 读取节点 | `GET /nodes` | 读 `coreGroup` 组内成员、当前选中、每个节点最近一次延迟 |
| 刷新订阅 | `POST /nodes/refresh` | 拉订阅 → 解析 → `PATCH /configs` 推给内核 → 回读 |
| 测速 | `POST /nodes/test` | 并发 4，单节点 3000 ms 超时，探针 `https://www.gstatic.com/generate_204` |
| 切换 | `POST /nodes/select` | 落成 `PUT /proxies/<coreGroup>`，内核侧真的换线 |

刷新订阅时，订阅请求走的是**插件自己的分流**：订阅域名填进上面的域名清单就会走代理
（机场域名一般都得这样，否则拉不到）。

解析支持三种格式，自动判别：

- **Clash / mihomo YAML** —— `proxies:` 段原样透传给内核（字段名就是内核的字段名，
  内核认识 `tuic` 之类本插件不翻译的协议）。缺 `name`/`type`/`server`/`port` 的条目会被
  跳过并在界面上报出条数。
- **sing-box JSON** —— 只取 `outbounds` 里可用的基本字段，跳过 `direct`/`block`/`dns`/
  `selector`/`urltest`；不认识的类型进「跳过」清单。
- **分享链接列表 / 整段 base64** —— `vless`（含 TLS / REALITY / WS / gRPC / flow）、
  `hysteria2`（`hy2://` 也行，含 obfs）、`trojan`、`ss`、`http`、`https`、`socks5`。
  别的协议（`tuic://`、`ssr://` 等）会在界面上报「无法识别的分享链接」，不会静默丢。

### 代理不通时自动切节点

打开 `nodesAuto` 后，两种信号会触发切换：

| 触发 | 判定 |
| --- | --- |
| 降级状态机报 `proxy-failed` | 上一节那套「连接失败 / 3000 ms 连不上 / 5000 ms 没响应头」 |
| 60 s 巡检 | 当前节点连续 2 次测不出延迟（同一个节点失败一次只记数，不切） |

切换目标的选择顺序：**可用 > 未测 > 失败**，同档取延迟最低；排除当前节点。切完写一行：

```
model-proxy: node -> B（当前节点 A 不可用）
```

防止来回抖：30 s 内不重复切；每小时最多切 12 次；没有可用节点就保持现状（继续直连），
不会把当前节点切成一个同样坏的。这些阈值在 `lib/nodes.js` 的 `POOL_DEFAULTS` 里。

### 已知边界

**`PATCH /configs` 是增量语义，但只在 mihomo ≥ 1.16。** 旧版 Clash 会拿整个配置覆盖，
你自己的规则和别的组会被冲掉。用之前先 `GET /version` 确认（配置卡片上的「读取节点」
能连上就说明 API 通了，但版本还得自己看一眼）。

**节点密钥不回传前端。** 界面上只看得到「已配置」，明文只存在内核配置里。

**手动与自动切换共用同一套限流。** 30 s / 每小时 12 次对点列表同样生效，被挡住时提示
`too-soon` 或 `rate-limited`。

## 托管内核（插件自己跑 mihomo 或 sing-box）

上一节要一个能接 Clash API 的内核。NekoBox 没有这个 API，所以如果你不想自己装
mihomo / sing-box，可以让插件代管：**下载、写配置、拉起、停掉全是插件自己干**，
出站固定走 `127.0.0.1:<coreMixedPort>`，控制面固定走 `127.0.0.1:<coreApiPort>`。

把**代理出口**选成「订阅代理」就进入这套：卡片里只剩订阅地址、两个端口和四个按钮，
另一个出口的内容自动隐藏。**点「启用 / 更新订阅」一个按钮走完全程**：

1. 存设置；2. 缺的内核就下载 + 解压（**mihomo 和 sing-box 都会补齐**，装在同一目录、
二进制名不同，可以共存）；3. 拉订阅 → 解析 → 按当前内核写配置；4. 停掉旧内核、用新配置拉起；
5. 读回节点清单并**自动测速**，节点按钮上直接显示延迟。

**用哪个内核由卡片上方的两个按钮选**（`mihomo` / `sing-box`，装好的会显示 ✓）：两者都通过
Clash 兼容 API 说话（sing-box 用 `experimental.clash_api`），所以节点列表、测速、自动切换对
内核是哪一种完全无感。**切换会重启内核**（节点重新握手几秒）。

| 内核 | 配置 | 装的是 |
| --- | --- | --- |
| mihomo | `config.yaml`（原生） | `MetaCubeX/mihomo` 的 `mihomo-<os>-<arch>-<版本>.zip` |
| sing-box | `config.json`（由 Clash 条目翻译） | `SagerNet/sing-box` 的 `sing-box-<版本>-<os>-<arch>.zip`（非 Windows 平台是 `.tar.gz`） |

| 按钮 | 做什么 |
| --- | --- |
| 启用 / 更新订阅 | 上面那五步一次做完（换订阅、改端口后再点一次即可） |
| 测速 | 只重测延迟，不动内核 |
| 停止内核 | win32 走 `taskkill /pid <pid> /T /F`，其他平台 `SIGTERM` → 5 s 后 `SIGKILL` |
| mihomo / sing-box | 选跑哪个内核（两个可以同时装着）；切换时插件先收掉旧进程再拉新的，端口不会互踩 |

启动命令的细节：

- **下载走插件自己的分流**：命中的域名（`github.com`）本来就走你的代理，所以墙内也能装。
- 版本发现走 `releases/latest` 的 302 `Location`，**不查 `api.github.com`**——匿名调用会 403。
- 解压先试 `tar -xf`（Win10+ 自带 bsdtar 能解 zip），失败退 `powershell Expand-Archive`。
- mihomo 的配置就是它自己的原生格式：`mixed-port` / `external-controller 127.0.0.1:<port>` /
  `dns: fake-ip` / 一个 `select` 组 + `rules: ["MATCH,<coreGroup>"]`。
  **没有节点时**退成 `proxies: []` + `rules: ["MATCH,DIRECT"]`（空组内核起不来）。
- sing-box 的配置是同一批节点**翻译**过去的（`lib/core-manager.js` 的 `buildSingboxConfig`）：
  `mixed` 入站 + `selector` 组 + `route.final` 指向它，控制面挂 `experimental.clash_api`。
  翻不了的协议（如 wireguard）会进 `skipped` 并打一行日志，不会让整份配置失效。
- 刷新订阅时会先停内核、重写配置文件、再拉起，所以新节点立刻生效。

### 已知边界

**重启 DSH 后第一次同步会自己拉一遍订阅。** 节点清单只存在内存里，重启后是空的；
所以插件在托管模式下若发现池子里没节点、又配了订阅地址，会先拉订阅再起内核——
否则内核会拿着一份没有节点、没有策略组的配置起来（界面表现为 `group-missing`）。

**内核进程跟着插件走。** 插件被停用/DSH 退出时会 `coreStop()`，端口不会留在后台；
但插件崩溃时内核可能成为孤儿进程，必要时 `taskkill /f /im mihomo.exe`。

**两个内核可以同时装着，但同一时间只跑一个（一个组、一组端口）。** 想同时跑两个代理出口得
自己起第二个内核，把 `coreMixedPort` 让给插件、第二个内核另用端口。

**sing-box 的节点是翻译过去的。** 订阅里的 Clash 字段（reality / ws / grpc / hysteria2 obfs /
tuic…）按最常见的写法映射；极其冷门的组合可能翻译不全，切换后看节点列表少没少就知道。

**Windows 之外没实机验证过。** 下载/解压/启动/停止的路径名和信号都按平台写了分支
（`taskkill` vs `SIGTERM`），但只在 Windows 上跑过真机测试。

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
node test/selftest.mjs         # 纯逻辑断言 + 假代理实跑 + 配置字段守卫
node test/client-domains.mjs   # 设置卡片域名输入的校验、去重、多值拆分
node test/client-writes.mjs    # 设置卡片：写队列、乐观锁、探针分项渲染（不许出现 undefined/未知）
node test/bridge-guard.mjs     # 设置桥：回环来源限制、信封层数（只包一层）、写字段白名单
node test/probe-guard.mjs      # 探针目标裁决（回环/内网/清单外一律拒）+ 失败原因映射
node test/catalog-offline.mjs  # 设置桥的 catalog 处理器，含 llm 缺席/抛错的降级
node test/dispatcher-race.mjs  # dispatcher 热更新/卸载的并发竞态
node test/undici-hook.mjs      # undici 全局 dispatcher 挂载与还原
node test/undici-stub.mjs      # 无网络环境下 undici 行为的桩测
node test/failover.mjs         # 死代理（127.0.0.1:1）→ 自动改直连
node test/failover-timeout.mjs # 不可路由代理（192.0.2.1）→ 连接超时后改直连
node test/subscription.mjs     # 订阅解析：vless/hysteria2/ss/Clash YAML/sing-box/垃圾输入/信息条目过滤
node test/nodes.mjs            # 节点池：排序、切换限流、失败降级、巡检两次才切、缓存恢复
node test/clash-api.mjs        # 内核 API 适配器（本地假内核，覆盖 5 个端点与错误码）
node test/core.mjs             # 托管内核：资产名/版本发现/配置生成/安装失败路径 + /core 四条路由
node test/core-race.mjs        # 内核进程：并发 start 复用同一进程、killSync 真杀、野内核先收掉
node test/live-proxy.mjs       # 打真实 NekoBox 的端到端实测
```

`test/core.mjs` 默认只跑离线断言。加 `DMP_CORE_LIVE=1` 会真的下载 20 MB 内核并启动一次
（`DMP_CORE_VERSION` 可指定版本），结束时删掉临时目录；墙内需要让下载走代理，例如
`DMP_CORE_LIVE=1 NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:2080 node test/core.mjs`。

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
- `lib/bridge.js` —— 设置桥的 HTTP 路由（只接受回环来源），含 `/nodes` 四个端点与 `/core` 四个端点
- `lib/subscription.js` —— 订阅解析（Clash YAML / sing-box / 分享链接）与「节点 → 内核配置」转换
- `lib/core-adapter.js` —— Clash 兼容 REST API 适配器：ping / list / delay / select / apply
- `lib/nodes.js` —— 节点池：健康度排序、切换限流、巡检、failover
- `lib/core-manager.js` —— 托管内核：版本发现、下载解压、配置生成、进程起停与状态快照
- `lib/core-manager.js` —— 托管内核进程：下载、解压、配置生成（mihomo / sing-box）、起停、野进程清理
- `lib/index.js` —— 插件入口：配置 schema、热更新接线、探针、节点管理段、托管内核段
- `lib/client.js` —— 设置卡片（免构建，直接注入宿主 `ModuleLoader`）
- `test/` —— 自检脚本，见上