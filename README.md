# dsh-websearch-zai-codingplan

让 DeepSeek Harness（DSH）的原生 `web_search` 走智谱官方「联网搜索 MCP」（`web_search_prime`），搜索计费落在 GLM Coding Plan 套餐搜索额度；并提供设置页，手动输入 API Key。

> English summary at the bottom.

## 功能

- **接管 `web_search`**：结果由智谱官方搜索 MCP 返回，消耗 GLM Coding Plan 的套餐搜索额度——不烧 DeepSeek 平台余额，也不走按量计费 API。
- **设置页手动填 Key**（Settings → 智谱搜索）：填写 / 清除本插件专用 API Key；Key 只写入 DSH 凭据服务，界面永不回显。
- **Key 解析链**：专用 Key（设置页存的）→ 共用引用 `ZAI_CODING_CN_API_KEY`（与 `zai-coding-cn` 模型通道同一把）→ 都没有才报错。不填专用 Key 时零配置可用。
- **换 Key 即时生效**：凭据服务按次解析，轮换后下一次搜索就用新值，无需重启。
- 自动停用内置 DeepSeek 搜索通道，避免抢占同一个工具位。

## 安装

**方式一：npm 一键安装（推荐）**

```sh
dsh plugin --profile desktop add dsh-web-search-zhipu-mcp
```

**方式二：从源码安装**

```sh
git clone https://github.com/wgl2zj/dsh-websearch-zai-codingplan.git
dsh plugin --profile desktop add link:<克隆目录绝对路径>
```

安装后彻底退出并重启 DSH 生效。卸载 / 回滚：

```sh
dsh plugin --profile desktop remove dsh-web-search-zhipu-mcp
```

移除后 DSH 的 `web_search` 回落内置 DeepSeek 通道。

## 使用

1. 在智谱开放平台（open.bigmodel.cn）确保你有 GLM Coding Plan 套餐；
2. 二选一提供凭据：
   - **设置页**（推荐）：Settings → 智谱搜索 → 粘贴 API Key → 保存；
   - 或沿用既有的 `ZAI_CODING_CN_API_KEY`（Models 页配置 `zai-coding-cn` 模型通道时写入的那把）；
3. 正常对话里让模型联网搜索即可，`web_search` 工具自动走智谱。

## 工作原理

```
DSH web_search 工具
   └─> 本插件 provider（zhipu-mcp-search）
         ├─ Key 解析：专用 ZHIPU_WEB_SEARCH_API_KEY → 共用 ZAI_CODING_CN_API_KEY（DSH 凭据服务）
         └─> POST https://open.bigmodel.cn/api/mcp/web_search_prime/mcp
               （MCP Streamable HTTP：initialize → initialized → tools/call）
               结果翻译回 DSH sources[]（{title,link,content} → {title,url,snippet}）

设置页（client.js，settings.section 槽位）
   └─> 本机回环路由 /dsh-web-search-zhipu-mcp/credentials（GET 查状态 / POST 存清）
         宿主半执行 credentials.set / unset / describe（带跨站栅栏，值不回显）
```

### 实测协议要点（服务端 mcp-web-search-prime，协议 2024-11-05）

- 工具名是全小写 `web_search_prime`（官方文档的驼峰名不存在）；入参 `search_query`（官方建议 ≤70 字符，插件放宽截到 120），另有 `search_recency_filter` / `search_domain_filter`；
- 响应是 SSE 帧（`id:` / `event:` / `data:` 行），`data:` 里才是 JSON-RPC 信封；
- `tools/call` 结果的 `content[0].text` 是**双重编码**：JSON 字符串里再套一段 JSON 数组，需剥两层才是 `[{title, link, content, refer}]`；
- 会话头 `mcp-session-id` 可复用，过期（HTTP 404）重握手一次即可。

## 开发

```sh
node --test test/unit.mjs   # 单元测试（解析 / 映射 / Key 回退链，不发网络请求）
node scripts/e2e.mjs        # 真凭据实弹一次搜索（读本机 ~/.dsh/.credentials.yaml，不回显）
```

插件为纯 ESM、零运行时依赖（仅 peer 依赖宿主的 `@deepseek-ai/dsh-credentials`）；装进 profile 后以 link 方式指向本目录，改完代码重启 DSH 即生效。

## 已知边界

- 一次搜索一次 MCP 会话，不复用跨搜索会话（DSH 搜索频率低，省去失效管理）；
- `search_recency_filter` / `search_domain_filter` 未接（模型侧无此入参通道）；
- 设置页文案当前为中文；凭据读写的回环路由带跨站栅栏（拒 cross-site、Origin 同源、仅回环地址）。

## 兼容性

- DSH 桌面版 0.2.2-rc.1 实测通过（Windows x64）；理论兼容同代 cordis 插件体系的 DSH 版本。
- Node ≥ 20（仅开发期跑测试需要）。

## License

[MIT](./LICENSE)
