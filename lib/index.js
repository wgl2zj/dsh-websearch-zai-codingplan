// dsh-web-search-zhipu-mcp — 让 DSH 的 web_search 走智谱官方「联网搜索 MCP」。
//
// 官方端点:https://open.bigmodel.cn/api/mcp/web_search_prime/mcp
// 鉴权:GLM Coding Plan 套餐 API Key(Bearer),搜索计费落在套餐搜索额度。
// 协议:MCP Streamable HTTP(JSON-RPC over POST,响应为 SSE 帧)。
// 实测坑(2026-11-10,协议版本 2024-11-05):
//   - 工具名是小写 web_search_prime,官方文档写的 webSearchPrime 不存在;
//   - 入参是 search_query(建议 ≤70 字符),另有 search_recency_filter /
//     search_domain_filter;
//   - 响应体是 SSE 帧(id/event/data 行),data 里才是 JSON-RPC 信封;
//   - tools/call 结果的 content[0].text 是一段 JSON 字符串,还要再 parse 一层,
//     元素形如 {title, link, content, refer}。

/** Cordis 插件名,供 loader 诊断使用。 */
export const name = "web-search-zhipu-mcp";

/** 注册进 DSH 的 web 能力面。凭据服务在运行时经 ctx.get 取,不占注入槽。 */
export const inject = ["web"];

/** provider id,与 cordis.patch.yml 里 searchProvider 的取值对应。 */
export const PROVIDER_ID = "zhipu-mcp-search";

/** 智谱官方「联网搜索 MCP」端点(coding plan 套餐额度)。 */
export const DEFAULT_BASE_URL =
  "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";

/** 凭据服务里的共用 key 引用名;与 DSH 模型通道 zai-coding-cn 共用同一把。 */
export const API_KEY_REF = "ZAI_CODING_CN_API_KEY";

/**
 * 本插件专用 key 引用名;网页端设置页(Settings → 智谱搜索)写入。
 * 解析优先级:专用引用 → 共用引用(0.2.0 起回退,保持零配置可用)。
 * 凭据服务语义:存储值优先于环境变量回退,轮换即时生效,无需重启。
 */
export const SEARCH_API_KEY_REF = "ZHIPU_WEB_SEARCH_API_KEY";

/** 官方 MCP 暴露的搜索工具名(实测为全小写,文档的驼峰名不存在)。 */
export const MCP_TOOL = "web_search_prime";

/** MCP 握手声明协议版本(服务端 2024-11-05,客户端声明 2025-03-26 可协商)。 */
const PROTOCOL_VERSION = "2025-03-26";

/** 单次搜索整体超时(毫秒);官方搜索通常 2~6 秒。 */
const TIMEOUT_MS = 30_000;

/** search_query 的安全上限;官方建议 70 字符,放宽到 120 防长查询被拒。 */
const QUERY_MAX_CHARS = 120;

/** MCP Streamable HTTP 请求统一要带的 Accept。 */
const ACCEPT = "application/json, text/event-stream";

/** 按 Unicode 码点截断,不切断代理对。 */
function clip(text, max) {
  const characters = [...text];
  return characters.length <= max ? text : characters.slice(0, max).join("");
}

/**
 * 从 MCP 的 SSE 响应文本里剥出 JSON-RPC 信封。
 *
 * 响应形如 `id:1\nevent:message\ndata:{...}\n\n`,可能多帧;优先取 id 匹配
 * 本请求的那帧,取不到再退最后一帧(通知类响应没有回执 id)。
 *
 * @param {string} text - 完整响应体。
 * @param {number|string} id - 本请求的 JSON-RPC id。
 * @returns {object} JSON-RPC 信封(含 result 或 error)。
 */
export function parseSsePayload(text, id) {
  const lines = String(text).split(/\r?\n/);
  const frames = [];
  let currentId = null;
  for (const line of lines) {
    if (line.startsWith("id:")) {
      currentId = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      const payload = line.slice(5).trim();
      if (payload.length > 0) frames.push({ id: currentId, payload });
    }
  }
  const wanted = String(id);
  const matching = frames.filter((frame) => frame.id === wanted);
  const chosen =
    matching.length > 0 ? matching[matching.length - 1] : frames[frames.length - 1];
  if (chosen === undefined) {
    throw new Error("智谱搜索 MCP 响应里没有可解析的 data 帧");
  }
  return JSON.parse(chosen.payload);
}

/**
 * 把 MCP tools/call 的结果翻译成 DSH web seam 认识的形状。
 *
 * @param {object} mcpResult - JSON-RPC result:{content:[{type:"text",text}...]}。
 * @returns {{content: string, sources: Array<{url: string, title: string, snippet: string}>, truncated: boolean}}
 */
export function mapSearchResult(mcpResult) {
  const block = (mcpResult?.content ?? []).find((part) => part?.type === "text");
  if (block === undefined || typeof block.text !== "string") {
    return { content: "", sources: [], truncated: false };
  }
  let rows;
  try {
    rows = JSON.parse(block.text);
    // 官方实测:text 是双重编码——JSON 字符串里再套一段 JSON 数组,剥两层。
    if (typeof rows === "string") rows = JSON.parse(rows);
  } catch {
    // 官方偶发直接回一段普通文本(如无结果说明),原文透传,不硬造来源。
    const plain = typeof rows === "string" ? rows : block.text;
    return { content: plain, sources: [], truncated: false };
  }
  if (!Array.isArray(rows)) rows = [rows];
  const seen = new Set();
  const sources = [];
  const lines = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const url = typeof row.link === "string" ? row.link : typeof row.url === "string" ? row.url : "";
    const title = typeof row.title === "string" ? row.title : "";
    const snippet = typeof row.content === "string" ? row.content : "";
    if (url.length > 0) {
      if (seen.has(url)) continue;
      seen.add(url);
    }
    sources.push({ url, title, snippet });
    const heading = title.length > 0 ? title : url;
    lines.push(snippet.length > 0 ? `${heading} — ${snippet}(${url})` : `${heading}(${url})`);
  }
  // truncated 是 web_search 工具输出 schema 的必填布尔(0.1.2 实测:缺失时宿主
  // 校验报 INVALID_TOOL_OUTPUT "not lossless JSON");官方 provider 恒 false,
  // 超过 maxResults 的截断由宿主 seam capSources 负责。
  return { content: lines.join("\n\n"), sources, truncated: false };
}

/**
 * 智谱官方搜索 MCP 的会话(握手、复用、调用)。
 *
 * 每次 search 新建实例:DSH 搜索频率低,省去跨请求的会话失效管理;
 * 服务端给的 mcp-session-id 在实例生命周期内复用,失效时重握手一次。
 */
export class ZhipuMcpSession {
  /**
   * @param {object} options
   * @param {string} options.baseURL - MCP 端点。
   * @param {string} options.apiKey - 套餐 API Key。
   * @param {AbortSignal} [options.signal] - 调用方取消信号。
   */
  constructor({ baseURL, apiKey, signal } = {}) {
    this.baseURL = baseURL;
    this.apiKey = apiKey;
    this.signal = signal;
    this.sessionId = "";
    this.nextId = 1;
  }

  /** 发一帧 JSON-RPC,返回剥壳后的信封。 */
  async #post(body, { withSession = true } = {}) {
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      Accept: ACCEPT,
    };
    if (withSession && this.sessionId !== "") headers["mcp-session-id"] = this.sessionId;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = this.signal === undefined ? timeout : AbortSignal.any([this.signal, timeout]);
    const response = await fetch(this.baseURL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `智谱搜索 MCP HTTP ${response.status}:${text.slice(0, 200) || "(无响应体)"}`,
      );
    }
    return text;
  }

  /**
   * 确保会话已建立:initialize 握手拿 mcp-session-id,再补 initialized 通知。
   * @param {boolean} [force] - true 时丢弃旧会话强制重握手。
   */
  async ensureSession(force = false) {
    if (this.sessionId !== "" && !force) return;
    const id = this.nextId++;
    const response = await fetch(this.baseURL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: ACCEPT,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: name, version: "0.1.0" },
        },
      }),
      signal:
        this.signal === undefined
          ? AbortSignal.timeout(TIMEOUT_MS)
          : AbortSignal.any([this.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `智谱搜索 MCP 握手 HTTP ${response.status}:${text.slice(0, 200) || "(无响应体)"}`,
      );
    }
    const headerSession = response.headers.get("mcp-session-id") ?? "";
    const envelope = parseSsePayload(text, id);
    if (envelope.error !== undefined) {
      throw new Error(`智谱搜索 MCP 握手被拒:${JSON.stringify(envelope.error)}`);
    }
    this.sessionId = headerSession !== "" ? headerSession : "";
    // 通知不期待回执;失败不致命(有的服务端不校验)。
    try {
      await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
    } catch {
      /* 通知失败忽略,后续调用失败时再重握手。 */
    }
  }

  /**
   * 调一次搜索工具;会话失效(HTTP 404 等)时重握手再试一次。
   * @param {Record<string, unknown>} args - 工具入参。
   * @returns {object} JSON-RPC result。
   */
  async callTool(args) {
    await this.ensureSession();
    let envelope;
    try {
      envelope = await this.#call(args);
    } catch (error) {
      // 会话被服务端过期回收时重握手一次;凭据/网络类错误原样上抛。
      if (String(error).includes("HTTP 404")) {
        await this.ensureSession(true);
        envelope = await this.#call(args);
      } else {
        throw error;
      }
    }
    if (envelope.error !== undefined) {
      throw new Error(`智谱搜索 MCP 返回错误:${JSON.stringify(envelope.error)}`);
    }
    return envelope.result;
  }

  async #call(args) {
    const id = this.nextId++;
    const text = await this.#post({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: MCP_TOOL, arguments: args },
    });
    return parseSsePayload(text, id);
  }
}

/**
 * 注册进 web seam 的搜索 provider。
 *
 * available() 只做本地廉价检查(恒真:端点为常量);ready() 查凭据能否解析;
 * search() 每次现解析凭据并走完整 MCP 调用。
 */
export class ZhipuMcpProvider {
  /** 注册表键:宿主 web 通道按 provider.id 建 Map(官方 provider 同款类字段);
   * 缺失时被注册到 undefined 名下,搜索报 WEB_PROVIDER_CONFIGURED_MISSING
   * (2026-11-10 0.1.1 实测踩坑,0.1.2 修复)。 */
  id = PROVIDER_ID;

  /**
   * @param {() => object} resolveCtx - 返回插件上下文;每次操作现取,便于测试替身。
   * @param {{warn?: (message: string) => void}} [options]
   */
  constructor(resolveCtx, options = {}) {
    this.resolveCtx = resolveCtx;
    this.warn = options.warn;
  }

  /** 本地廉价可用性检查:端点恒为官方常量,恒可用。 */
  available() {
    return true;
  }

  /**
   * 下一次搜索能否带上凭据(只查配置与凭据面,不发网络请求)。
   * @param {string} [_llmProvider] - seam 传入的模型路由 id;本插件不使用。
   */
  async ready(_llmProvider) {
    try {
      const apiKey = await this.#resolveApiKey();
      return typeof apiKey === "string" && apiKey.length > 0;
    } catch (error) {
      this.warn?.(`智谱搜索 MCP 就绪检查失败:${String(error)}`);
      return false;
    }
  }

  /**
   * 运行一次搜索。
   * @param {{query: string}} request - seam 搜索请求。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<{content: string, sources: Array<object>, truncated: boolean}>}
   */
  async search(request, signal) {
    const query = typeof request?.query === "string" ? request.query.trim() : "";
    if (query.length === 0) {
      throw new Error("智谱搜索 MCP:搜索词为空", { cause: "WEB_PROVIDER_REQUEST" });
    }
    const apiKey = await this.#resolveApiKey();
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new Error(
        `web search has no API key; store one on the Settings page "Zhipu web search" (credential refs ${SEARCH_API_KEY_REF} / ${API_KEY_REF})`,
        { cause: "WEB_PROVIDER_CREDENTIAL_MISSING" },
      );
    }
    const session = new ZhipuMcpSession({
      baseURL: DEFAULT_BASE_URL,
      apiKey,
      signal,
    });
    const result = await session.callTool({
      search_query: clip(query, QUERY_MAX_CHARS),
    });
    return mapSearchResult(result);
  }

  /**
   * 解析搜索用 API Key:专用引用优先,共用引用回退(0.2.0)。
   * 两条链都查不到时返回 undefined,由调用方按无凭据处理。
   */
  async #resolveApiKey() {
    const ctx = this.resolveCtx();
    return resolveProviderApiKey(ctx?.get?.("credentials"));
  }
}

/** @deepeek-ai/dsh-credentials 的 credentialRef 探测缓存:null 未探测,false 不可用。 */
let credentialRefFn = null;

/** 凭据名 → 宿主品牌化引用;宿主包不可达时回退裸名(resolve 不认就按无凭据)。 */
async function toCredentialRef(refName) {
  if (credentialRefFn === null) {
    try {
      const mod = await import("@deepseek-ai/dsh-credentials");
      credentialRefFn =
        typeof mod.credentialRef === "function" ? mod.credentialRef : false;
    } catch {
      credentialRefFn = false;
    }
  }
  return credentialRefFn ? credentialRefFn(refName) : refName;
}

/**
 * 按「专用引用 → 共用引用」顺序解析凭据值;空字符串按不存在处理
 * (凭据服务语义:空值不可存储,等同未设置)。导出供单测直测回退链。
 *
 * @param {object|undefined} credentials - 宿主凭据服务(ctx.get("credentials"))。
 * @returns {Promise<string|undefined>} 第一个非空 key 值;都没有则 undefined。
 */
export async function resolveProviderApiKey(credentials) {
  if (credentials === undefined) return undefined;
  for (const refName of [SEARCH_API_KEY_REF, API_KEY_REF]) {
    const ref = await toCredentialRef(refName);
    const resolved = await credentials.resolve(ref);
    const value = resolved?.value;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * 插件入口:注册搜索 provider + 设置页凭据路由。
 *
 * 注意:本文件绝不能加 default 导出。DSH 装载器 unwrapExports 取
 * `exports.default ?? exports`,一旦存在 default 导出,插件就被替换成
 * 裸 apply 函数,模块级 `export const inject` 声明随之丢失,apply 里的
 * ctx.web 会触发框架守卫报错 `cannot get property "web" without inject`
 * (2026-11-10 实测;官方 dsh-web-search-deepseek 同样只给命名导出)。
 *
 * 0.2.1 教训(0.2.0 实测踩坑,三次重启复现):客户端模块的 inject 只能声明
 * 客户端 fiber 真实提供的服务(slots/locale/…);声明 remote/remote.credentials
 * 会让 cordis fiber 的 await() 永远等不到提供方,entry 卡 loading,web boot
 * 监督判死「1 entry did not activate」。客户端半已改为只注 slots,凭据读写
 * 走本文件注册的 webServer 路由(0.1.x~0.2.0 期间 tokens-card 同款通道)。
 *
 * @param {object} ctx - Cordis 插件上下文。
 */
export function apply(ctx) {
  const warn = (message) => ctx.logger?.warn?.(message);
  ctx.web.registerSearchProvider(
    new ZhipuMcpProvider(() => ctx, { warn }),
  );
  const offRoute = registerCredentialRoute(ctx);
  return () => {
    offRoute();
  };
}

/** 设置页凭据路由路径(与 client.js 的 ROUTE 常量保持一致)。 */
export const CREDENTIALS_ROUTE = "/dsh-web-search-zhipu-mcp/credentials";

/** 路由 JSON 响应统一头。 */
const ROUTE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

/** 请求体上限;API Key 远小于此,防滥用。 */
const BODY_MAX_BYTES = 64 * 1024;

/** 请求 Host 头是否本机回环(桌面 GUI 恒为 127.0.0.1:port)。 */
function isLoopbackHost(hostHeader) {
  const host = String(hostHeader ?? "").toLowerCase();
  return host.startsWith("127.0.0.1:") || host.startsWith("localhost:") ||
    host === "127.0.0.1" || host === "localhost" ||
    host.startsWith("[::1]:") || host === "[::1]";
}

/**
 * 设置页路由的请求栅栏(参照 tokens-card rejectRequest,放行 GET/POST):
 * 拒跨站标记、Origin 必须与 Host 同源、仅回环地址,宿主栅栏可用再委托复核。
 *
 * @returns {boolean} true = 已拒并写回响应,调用方直接返回。
 */
function rejectRequest(req, res, connection) {
  const method = String(req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    try {
      res.writeHead(405, { ...ROUTE_HEADERS, Allow: "GET, POST" });
      res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
    } catch { /* 连接已断 */ }
    return true;
  }
  if (String(req.headers?.["sec-fetch-site"] ?? "") === "cross-site") {
    try {
      res.writeHead(403, ROUTE_HEADERS);
      res.end(JSON.stringify({ ok: false, error: "cross-site forbidden" }));
    } catch { /* 连接已断 */ }
    return true;
  }
  const origin = req.headers?.origin;
  if (typeof origin === "string" && origin.length > 0) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === String(req.headers?.host ?? "");
    } catch { sameOrigin = false; }
    if (!sameOrigin) {
      try {
        res.writeHead(403, ROUTE_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "origin forbidden" }));
      } catch { /* 连接已断 */ }
      return true;
    }
  }
  if (!isLoopbackHost(req.headers?.host)) {
    if (connection !== undefined && typeof connection.requestRejection === "function") {
      let rejection;
      try {
        rejection = connection.requestRejection(req);
      } catch {
        rejection = true;
      }
      if (rejection) {
        try {
          res.writeHead(403, ROUTE_HEADERS);
          res.end(JSON.stringify({ ok: false, error: "rejected by host fence" }));
        } catch { /* 连接已断 */ }
        return true;
      }
    } else {
      try {
        res.writeHead(403, ROUTE_HEADERS);
        res.end(JSON.stringify({ ok: false, error: "non-loopback forbidden" }));
      } catch { /* 连接已断 */ }
      return true;
    }
  }
  return false;
}

/** 读完请求体并按 JSON 解析;超限或非 JSON 返回 undefined。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX_BYTES) {
        finish(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        finish(text.length > 0 ? JSON.parse(text) : undefined);
      } catch {
        finish(undefined);
      }
    });
    req.on("error", () => finish(undefined));
  });
}

/** 写 JSON 响应;连接已断时静默。 */
function writeJson(res, status, payload) {
  try {
    res.writeHead(status, ROUTE_HEADERS);
    res.end(JSON.stringify(payload));
  } catch { /* 连接已断 */ }
}

/** 查一个凭据引用的已设置状态(只报 configured,绝不带值)。 */
async function describeRef(credentials, refName) {
  if (credentials === undefined || typeof credentials.describe !== "function") {
    return { configured: false, available: false };
  }
  try {
    const info = await credentials.describe(await toCredentialRef(refName));
    return { configured: info?.configured === true, available: true };
  } catch {
    return { configured: false, available: true };
  }
}

/**
 * 注册设置页凭据路由(GET 查状态 / POST 存清专用 Key)。
 *
 * 通道沿用 tokens-card 已验证的 webServer 注册形状;webServer/connection
 * 缺失的宿主上经 ctx.inject 静默跳过——搜索照常,仅设置页无数据。
 * 客户端模块绝不能直接注入 credentials 服务(见 apply 注释的 0.2.0 教训),
 * 一切凭据读写都经这条本机回环路由完成。
 *
 * @param {object} ctx - Cordis 插件上下文。
 * @returns {() => void} 注销路由的清理函数。
 */
function registerCredentialRoute(ctx) {
  let offRoute = () => {};
  try {
    ctx.inject(["webServer", "connection"], (svc) => {
      const webServer = svc && (svc.webServer ?? (svc.get && svc.get("webServer")));
      const connection = svc && (svc.connection ?? (svc.get && svc.get("connection")));
      if (webServer === undefined || typeof webServer.register !== "function") return;
      const off = webServer.register({
        kind: "exact",
        path: CREDENTIALS_ROUTE,
        handler: async (req, res) => {
          if (rejectRequest(req, res, connection)) return;
          const credentials = ctx.get?.("credentials");
          try {
            if (String(req.method ?? "").toUpperCase() === "GET") {
              writeJson(res, 200, {
                ok: true,
                dedicated: await describeRef(credentials, SEARCH_API_KEY_REF),
                fallback: await describeRef(credentials, API_KEY_REF),
              });
              return;
            }
            if (credentials === undefined || typeof credentials.set !== "function") {
              writeJson(res, 500, { ok: false, error: "credentials service unavailable" });
              return;
            }
            const body = await readJsonBody(req);
            if (body?.op === "set") {
              const value = typeof body.value === "string" ? body.value.trim() : "";
              if (value.length === 0) {
                writeJson(res, 400, { ok: false, error: "empty key" });
                return;
              }
              await credentials.set(await toCredentialRef(SEARCH_API_KEY_REF), value);
              writeJson(res, 200, { ok: true });
              return;
            }
            if (body?.op === "unset") {
              await credentials.unset(await toCredentialRef(SEARCH_API_KEY_REF));
              writeJson(res, 200, { ok: true });
              return;
            }
            writeJson(res, 400, { ok: false, error: "unknown op" });
          } catch (error) {
            writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
          }
        },
      });
      if (typeof off === "function") offRoute = off;
    });
  } catch {
    /* 老宿主无 webServer:静默降级,搜索照常,仅设置页无数据。 */
  }
  return () => {
    try {
      offRoute();
    } catch {
      /* 已注销 */
    }
  };
}
