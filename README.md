# dsh-bigmodel-consume

在 DeepSeek Harness（DSH）对话输入区实时显示智谱 GLM CodingPlan 用量：**5 小时窗口**与**每周窗口**还剩多少，附带月度 MCP 额度、重置倒计时与套餐档位。

用户只需填入自己的智谱 API Key；当前会话使用智谱模型（zai / glm）时，模型选择器左侧会出现用量药丸，点击展开用量弹窗。

## 功能

- **用量药丸**（`conversation.input.right` 插槽，模型选择器左侧，参照 opencode-go 的 UsagePill）：当前会话选中智谱模型时才显示；状态点 + `GLM 5h 73% · 周 95%` 剩余百分比，按余量自动变色（绿 ≥30% → 橙 <30% → 红 <10%）。非智谱模型时自动隐藏。
- **用量弹窗**：点击药丸展开——5 小时 / 每周 / 月度 MCP 三个窗口的进度条、已用/总量积分、重置时间与倒计时、套餐档位、Key 来源、手动刷新；未配置 Key 时就地提供录入表单。
- **设置页**（`settings.section` 插槽，「GLM 用量」）：API Key 输入（保存前真实校验，认证失败不落盘）、组织/项目 ID（新版积分套餐用）、套餐类型（团队=2 / 个人=1）、区域（bigmodel.cn / z.ai）、自动刷新间隔（1–60 分钟）。
- **自动轮询**：默认每 5 分钟后台刷新，页面不可见时暂停；弹窗打开时数据超过 60 秒自动刷新；连接重置后自动重取。
- **零配置起步**：不填 Key 时自动回退使用 DSH 凭据库的 `ZAI_API_KEY`（官方控制台同一把 Key），再回退环境变量。

## 安装

本机已完成安装（desktop profile）。在新机器上安装：

```bash
# 方式一：CLI（dsh 在 PATH 时）
dsh plugin --profile desktop add <本目录路径>

# 方式二：Web 界面
# 侧栏 → Plugins → Install from path → 填本目录路径
```

安装后如未热加载，重启 DSH 桌面端即可。卸载：Plugins 页里移除本包。

## API Key 与新版积分套餐

- **旧版套餐**：只需 API Key。宿主端以 Bearer 方式请求
  `https://open.bigmodel.cn/api/monitor/usage/quota/limit`。
- **新版积分套餐**（2026-07 改版后，含团队套餐）：需要组织/项目上下文。获取方法：
  登录 [bigmodel.cn/coding-plan](https://bigmodel.cn/coding-plan)，打开浏览器 DevTools 的 Network，
  找到 `api/monitor/usage/quota/limit` 请求，请求头 `bigmodel-organization` / `bigmodel-project`
  即组织/项目 ID，URL query `type` 即套餐类型（团队=2，个人=1）。填入设置页对应字段即可。

响应中的 `limits` 行按 `unit` 区分窗口（3=小时窗、6=周窗），`percentage` 为已用百分比，
`currentValue`/`usage`/`remaining` 为已用/总量/剩余积分，`nextResetTime` 为窗口重置时间（unix 毫秒）。

## 架构

DSH 插件是「宿主端 + 浏览器端」双半结构，本插件**零 npm 依赖、零构建**：

| 文件 | 角色 |
|---|---|
| [src/index.js](src/index.js) | 宿主端 Cordis 插件：在宿主 Web 服务注册同源 `/api/bigmodel-usage.{config,setConfig,usage}` POST 路由（复用 DSH 客户端 RPC 信封协议），转发智谱 monitor 端点请求——绕开浏览器 CORS；管理 Key 与配置（`<dsh home>/plugins/dsh-bigmodel-consume/config.json`，原子写入，永不回传完整 Key） |
| [src/client.js](src/client.js) | 浏览器端 client bundle（`window.__ModuleLoader__.load` 格式，手写无需 tsdown）：React 组件 + 本地化词典 + 样式注入；通过 `connection.rpc.call('/api', 'bigmodel-usage.*', payload)` 调用宿主端；用 `modelDirectories.directoryFor(sessionId)` 的目录 store 感知当前会话模型（`current.provider` 为 zai/glm 时才渲染药丸） |
| [cordis.patch.yml](cordis.patch.yml) | 安装时自动挂载宿主端入口 |
| [package.json](package.json) | `dsh.bundle.patch` 自激活声明 + `dsh.client` 浏览器 bundle 声明 |

两代协议的请求差异（Bearer/raw 认证、组织头、`?type=` query）在宿主端按配置与响应自动适配，
认证失败会翻转 `Authorization` 形式重试。usage 结果缓存 60 秒。

## 兼容性设计（抗 DSH 版本演进）

插件刻意把对宿主内部接口的耦合压到最小，并做了四层防护：

1. **失败软着陆**：客户端 `apply` 的每个关注点（词典/样式/轮询/药丸/设置页）独立 try/catch；
   任何一块宿主接口变化，只降级那一块，其余功能照常，绝不拖累 DSH 外壳
   （DSH 本身也会把加载失败的插件隔离在插件页报 error，不影响其他功能）。
2. **插槽降级链**：药丸首选 `conversation.input.right`（模型选择器左侧）；
   该插槽被改名/移除时自动降级到 `conversation.composer.dock`，并输出 console 警告。
3. **双协议数据通道**：优先走 DSH 的 `/api` RPC 信封；若信封/通道契约变化（DSH 0.1.5 曾改过一次），
   客户端自动退回普通同源 `fetch`，宿主端同时接受信封与裸 JSON 两种请求体，同一路由无需改动。
4. **令牌兜底**：所有 CSS 设计令牌带系统色（Canvas/CanvasText/GrayText）兜底，
   令牌改名只会让界面变朴素，不会破相。

此外宿主端对 `@deepseek-ai/dsh-home-paths` 的动态导入带 env/homedir 兜底；
`modelDirectories` 接口变化时药丸安全隐藏而非崩溃。

**DSH 更新后的体检**：

```bash
node doctor.mjs        # 30 秒逐层体检：宿主在线 → 启动图 → bundle → /api 双协议 → 智谱上游
```

每层给 PASS/WARN/FAIL 与处置建议；出现 FAIL 时按输出的层级定位（L2 重装包、L4 宿主接口变化、L5 智谱协议改版）。

## 本地验证

```bash
node smoke.mjs        # 宿主端端点 + 真实 API 调用 + 客户端结构与降级路径冒烟
node verify.mjs       # 对运行中的 DSH 宿主（127.0.0.1:19387）做端到端验证
```
