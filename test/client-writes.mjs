/**
 * 自检：卡片里三个写操作（persistDomains / save / test）在请求失败后必须解锁。
 *
 * 审查实测的口子（M1）：`setSaving(true)` 之后任何 reject 都让 `setSaving(false)` 永不执行
 * ——按钮永久卡在「保存中…」，用户只能刷新页面。这里用最小 React 桩真跑一遍组件：
 * 注入 reject 的 fetch，点按钮，断言按钮回到可点、错误显示出来。
 *
 * 为什么值得单独一个文件：这三个函数都内联在组件里，只能靠真渲染驱动。
 * 桩的 useCallback/useMemo 是真的按 deps memo（不然 refresh 的 effect 会无限重跑），
 * 并且每次渲染都重置 hook 游标 —— 渲染两次时的 hook 调用顺序不一致会当场炸出来。
 *
 * 跑法：node test/client-writes.mjs
 */
import assert from "node:assert/strict";

const registrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration);
    },
  },
};

await import("../lib/client.js");

// ── 最小 React：只实现这个卡片用到的 hook ───────────────────────────────────
function createReact() {
  const states = [];
  const memos = [];
  const effects = [];
  const effectDeps = [];
  let cursor = 0;
  let dirty = false;
  let hookCount = -1;

  const depsChanged = (prev, next) =>
    prev === undefined || next === undefined || prev.length !== next.length || next.some((item, i) => !Object.is(item, prev[i]));

  const memo = (index, compute, deps) => {
    const prev = memos[index];
    if (prev === undefined || depsChanged(prev.deps, deps)) memos[index] = { value: compute(), deps };
    return memos[index].value;
  };

  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (states.length <= index) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], (value) => {
        const next = typeof value === "function" ? value(states[index]) : value;
        // React 对 Object.is 相等的值直接 bail out（不重渲染）；桩也得这样，
        // 否则「设成同一个值」会被当成变更，把渲染循环的问题演成无限重渲染
        if (Object.is(next, states[index])) return;
        states[index] = next;
        dirty = true;
      }];
    },
    useCallback(fn, deps) {
      return memo(cursor++, () => fn, deps);
    },
    useMemo(fn, deps) {
      return memo(cursor++, fn, deps);
    },
    useRef(initial) {
      return memo(cursor++, () => ({ current: initial }), []);
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (depsChanged(effectDeps[index], deps)) {
        effectDeps[index] = deps;
        effects.push(fn);
      }
    },
  };

  return {
    hooks,
    begin() {
      cursor = 0;
      effects.length = 0;
      dirty = false;
    },
    end() {
      const count = cursor;
      if (hookCount !== -1) assert.equal(count, hookCount, "两次渲染的 hook 调用数必须一致（hook 顺序不能变）");
      hookCount = count;
    },
    get dirty() {
      return dirty;
    },
    get effects() {
      return effects;
    },
  };
}

const react = createReact();
const client = registrations[0].factory((specifier) => {
  if (specifier === "react") return react.hooks;
  if (specifier === "react/jsx-runtime") return { jsx: (type, props) => ({ type, props }) };
  throw new Error(`unexpected require: ${specifier}`);
});
const { ProxyCard } = client;

// ── 桩 fetch：/describe 与 /catalog 正常，写接口按 failOn 注入失败 ───────────
const CONFIG = {
  enabled: false,
  mode: "allowlist",
  proxyUrl: "http://127.0.0.1:2080",
  selected: ["api.example.com"],
  // 非空才测得出 L4：空的话「删空后被旧值填回」根本无从发生
  bypass: ["localhost"],
};
const STATUS = { active: true, mode: "allowlist", proxyUrl: "http://127.0.0.1:2080" };
const failOn = new Set();
const posts = [];

const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => payload });

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const suffix = target.slice(target.lastIndexOf("/"));
  if (init.method === "POST") {
    const body = JSON.parse(init.body);
    posts.push({ suffix, body });
    if (failOn.has(suffix)) throw new Error("network down");
    const value = body.ops?.[0]?.value;
    return jsonResponse({
      ok: true,
      value: {
        status: STATUS,
        config: { ...CONFIG, selected: value ?? CONFIG.selected },
        // 宿主每次写都会把 revision 往上推一格，客户端必须跟着走（M3）
        descriptor: {
          ns: "model-proxy",
          revision: (typeof body.expectedRevision === "number" ? body.expectedRevision : 7) + 1,
        },
      },
    });
  }
  if (suffix === "/describe") {
    return jsonResponse({
      ok: true,
      value: { ns: "model-proxy", config: CONFIG, status: STATUS, descriptor: { ns: "model-proxy", revision: 7 } },
    });
  }
  if (suffix === "/catalog")
    return jsonResponse({
      ok: true,
      value: {
        rows: [
          { provider: "openai", displayName: "OpenAI", hosts: ["a.example.org"], models: [] },
          { provider: "google", displayName: "Google", hosts: ["b.example.org"], models: [] },
        ],
      },
    });
  throw new Error(`unexpected fetch: ${target}`);
};

// ── 渲染 + 收敛 ───────────────────────────────────────────────────────────
let tree = null;
async function settle() {
  for (let round = 0; round < 16; round += 1) {
    react.begin();
    tree = ProxyCard({});
    react.end();
    // 组件的 effect 是 `void refresh()`，故意不返回 promise（React 里也没人 await），
    // 所以这里不能 await 它 —— 只能让出事件循环，等那串 fetch 的 promise 落定。
    for (const effect of react.effects) effect();
    await new Promise((resolve) => setImmediate(resolve));
    if (!react.dirty) return tree;
  }
  throw new Error("渲染未收敛（疑似无限重渲染）");
}

/** 只同步重渲染一次、不让出事件循环：用来观察请求「在飞」时的界面（如「保存中…」）。 */
function renderNow() {
  react.begin();
  tree = ProxyCard({});
  react.end();
  return tree;
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  walk(node.props?.children, visit);
}

/** 按按钮文字找节点（children 是字符串时才比）。 */
function buttonByText(text) {
  let hit = null;
  const seen = [];
  walk(tree, (node) => {
    if (node.type === "button") seen.push(node.props?.children);
    if (hit === null && node.type === "button" && node.props?.children === text) hit = node;
  });
  assert.ok(
    hit,
    `找不到文字为「${text}」的按钮；tree=${tree === null ? "null" : JSON.stringify(tree.props?.className ?? tree.type)}；` +
      `现有按钮=${JSON.stringify(seen)}；文本头部=${JSON.stringify(textNodes().slice(0, 4))}`,
  );
  return hit;
}

function textNodes() {
  const texts = [];
  walk(tree, (node) => {
    if (typeof node.props?.children === "string") texts.push(node.props.children);
  });
  return texts;
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

// ── 用例 ──────────────────────────────────────────────────────────────────
await test("基线：卡片渲染出「保存」按钮且可点", async () => {
  await settle();
  const button = buttonByText("保存");
  assert.equal(button.props.disabled, false);
  assert.ok(textNodes().includes("api.example.com"), "已配置的域名应渲染成 chip");
});

// M2：addDomains 原来读闭包里的 `domains`，同一个 tick 里点两个 chip 都拿旧值算 next，
// 后落盘的那次把前一次覆盖掉（丢写）。改成读 ref + 写队列串行后不再丢。
await test("M2 连点两个 chip 不丢写（同一 tick 的两次读改写在 ref 上串起来）", async () => {
  await settle();
  posts.length = 0;
  const first = buttonByText("a.example.org");
  const second = buttonByText("b.example.org");
  first.props.onClick();
  second.props.onClick(); // 故意不重渲染：两次回调拿到的是同一份旧 domains
  await settle();
  const mutate = posts.filter((entry) => entry.suffix === "/mutate").at(-1);
  assert.ok(mutate, "点 chip 应发起 /mutate");
  assert.deepEqual(
    mutate.body.ops[0].value,
    ["api.example.com", "a.example.org", "b.example.org"],
    "最后一个写请求必须带上完整清单（两个新域名都在）",
  );
  assert.ok(textNodes().includes("b.example.org"), "两个域名都要出现在界面上");
});

await test("M1 save：/mutate reject 后按钮退出「保存中…」并显示错误", async () => {
  failOn.add("/mutate");
  await settle();
  const promise = buttonByText("保存").props.onClick();

  renderNow();
  assert.equal(buttonByText("保存中…").props.disabled, true, "在飞期间应显示保存中并禁用");

  await promise;
  await settle();
  const button = buttonByText("保存");
  assert.equal(button.props.disabled, false, "失败后必须解锁，否则按钮永久点不动");
  assert.ok(textNodes().includes("network down"), `错误要显示出来，实际：${JSON.stringify(textNodes())}`);
  failOn.clear();
});

await test("M1 test：/probe reject 后「测试」按钮退出「测试中…」并给出失败结论", async () => {
  failOn.add("/probe");
  await settle();
  const promise = buttonByText("测试").props.onClick();
  renderNow();
  assert.equal(buttonByText("测试中…").props.disabled, true, "在飞期间应显示测试中并禁用");
  await promise;
  await settle();
  assert.equal(buttonByText("测试").props.disabled, false, "探针失败后测试按钮必须可再点");
  assert.ok(
    textNodes().some((text) => text.includes("测试结果") && text.includes("没能送到插件后端")),
    `探针区应显示失败结论，实际：${JSON.stringify(textNodes().filter((text) => text.includes("测试结果")))}`,
  );
  failOn.clear();
});

// 这条放最后：删 chip 只改本地 state（写失败也不回滚），会把 listed 清空，
// 后面的用例再想探针就只剩「域名列表是空的」了。
await test("M1 persistDomains：删 chip 时写失败也要解锁（不能卡在「保存中…」）", async () => {
  failOn.add("/mutate");
  await settle();
  let del = null;
  walk(tree, (node) => {
    if (del === null && node.type === "button" && node.props?.children === "✕") del = node;
  });
  assert.ok(del, "找不到域名 chip 的删除按钮");
  del.props.onClick();
  renderNow();
  assert.equal(buttonByText("保存中…").props.disabled, true, "在飞期间应显示保存中并禁用");
  await settle();
  await settle();
  assert.equal(buttonByText("保存").props.disabled, false, "删域名失败后同样要解锁");
  assert.ok(textNodes().includes("network down"), "写失败要报错，别静默 —— 卡死的按钮＋无提示才是审查里的那个坑");
  failOn.clear();
});

await test("M3 写请求必须带 expectedRevision（宿主的乐观锁只在传了它才生效）", async () => {
  await settle();
  posts.length = 0;
  await buttonByText("保存").props.onClick();
  await settle();
  const first = posts.find((entry) => entry.suffix === "/mutate");
  assert.ok(first, "保存应发起 /mutate");
  assert.equal(typeof first.body.expectedRevision, "number", "不传 expectedRevision 时两个窗口会静默互相覆盖");
  assert.deepEqual(
    first.body.ops.map((op) => op.path.join(".")),
    ["rules.enabled", "rules.mode", "rules.proxyUrl", "rules.bypass"],
    "保存只写这四个字段，别顺手动 selected",
  );

  // 写成功后 revision 必须跟着涨，否则下一次写永远撞自己那个已经作废的 revision
  posts.length = 0;
  await buttonByText("保存").props.onClick();
  await settle();
  const second = posts.find((entry) => entry.suffix === "/mutate");
  assert.equal(second.body.expectedRevision, first.body.expectedRevision + 1, "第二次写要用新 revision");
});

// L4：bypass 的初值 effect 原来依赖 [config, bypassText]，用户把输入框删空后
// bypassText === "" 立刻又把旧配置填回去 —— 于是 bypass 永远清不空。
await test("L4 bypass 输入框删空后不会被旧值填回", async () => {
  await settle();
  const findBypass = () => {
    let area = null;
    walk(tree, (node) => {
      if (area === null && node.type === "textarea") area = node;
    });
    return area;
  };
  const initial = findBypass();
  assert.ok(initial, "找不到 bypass 输入框");
  assert.equal(initial.props.value, "localhost", "bypass 初值应来自配置");

  initial.props.onChange({ target: { value: "" } });
  await settle();
  assert.equal(findBypass().props.value, "", "删空后不能被旧配置填回去，否则 bypass 永远清不掉");
});

for (const line of failures) console.error(`FAIL ${line}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
