// dsh-web-search-zhipu-mcp 解析与映射单测(纯函数,不发网络请求)。
// 运行:node test/unit.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  API_KEY_REF,
  MCP_TOOL,
  PROVIDER_ID,
  SEARCH_API_KEY_REF,
  ZhipuMcpProvider,
  mapSearchResult,
  parseSsePayload,
  resolveProviderApiKey,
} from "../lib/index.js";

test("parseSsePayload:剥出 initialize 的 data 帧(实测响应回放)", () => {
  const body = [
    "id:1",
    "event:message",
    'data:{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"logging":{},"tools":{"listChanged":true}},"serverInfo":{"name":"mcp-web-search-prime","version":"0.0.1"}}}',
    "",
    "",
  ].join("\n");
  const envelope = parseSsePayload(body, 1);
  assert.equal(envelope.error, undefined);
  assert.equal(envelope.result.serverInfo.name, "mcp-web-search-prime");
});

test("parseSsePayload:多帧时按请求 id 取帧,取不到退最后一帧", () => {
  const body = [
    "id:1",
    'data:{"jsonrpc":"2.0","id":1,"result":{"which":1}}',
    "",
    "id:2",
    'data:{"jsonrpc":"2.0","id":2,"result":{"which":2}}',
    "",
    "id:3",
    'data:{"jsonrpc":"2.0","id":3,"result":{"which":3}}',
    "",
  ].join("\n");
  assert.equal(parseSsePayload(body, 2).result.which, 2);
  // 通知回执没有 id,退最后一帧
  assert.equal(parseSsePayload(body, 99).result.which, 3);
});

test("parseSsePayload:没有 data 帧时报错", () => {
  assert.throws(() => parseSsePayload("event:ping\n\n", 1), /data 帧/);
});

test("mapSearchResult:映射实测 tools/call 返回(link→url,content→snippet)", () => {
  const inner = [
    {
      title: "DeepSeek Harness｜共探智能上限",
      link: "https://www.deepseek.com/zh/harness",
      content: "2026年9月4日 — 使用 DeepSeek Harness 整理文档。",
      refer: "ref_1",
    },
    {
      title: "DeepSeek Harness: Everything is a Plugin.",
      link: "https://github.com/deepseek-ai/deepseek-harness",
      content: "open-source agent harness",
      refer: "ref_2",
    },
  ];
  const mcpResult = {
    content: [{ type: "text", text: JSON.stringify(inner) }],
  };
  const mapped = mapSearchResult(mcpResult);
  assert.equal(mapped.sources.length, 2);
  assert.deepEqual(Object.keys(mapped.sources[0]).sort(), ["snippet", "title", "url"]);
  assert.equal(mapped.sources[0].url, "https://www.deepseek.com/zh/harness");
  assert.equal(mapped.sources[0].snippet, "2026年9月4日 — 使用 DeepSeek Harness 整理文档。");
  assert.ok(mapped.content.includes("DeepSeek Harness｜共探智能上限"));
  assert.ok(mapped.content.includes("https://github.com/deepseek-ai/deepseek-harness"));
});

test("mapSearchResult:按 URL 去重且保序", () => {
  const rows = [
    { title: "a", link: "https://x.example/a", content: "1" },
    { title: "a-dup", link: "https://x.example/a", content: "1-dup" },
    { title: "b", link: "https://x.example/b", content: "2" },
  ];
  const mapped = mapSearchResult({ content: [{ type: "text", text: JSON.stringify(rows) }] });
  assert.deepEqual(
    mapped.sources.map((source) => source.url),
    ["https://x.example/a", "https://x.example/b"],
  );
});

test("mapSearchResult:官方双重编码(text 是字符串套字符串)也能剥两层", () => {
  // 实测:tools/call 的 content[0].text 值本身是一段带引号的 JSON 字符串。
  const rows = [{ title: "t", link: "https://x.example/a", content: "s", refer: "ref_1" }];
  const doubleEncoded = JSON.stringify(JSON.stringify(rows));
  const mapped = mapSearchResult({ content: [{ type: "text", text: doubleEncoded }] });
  assert.equal(mapped.sources.length, 1);
  assert.equal(mapped.sources[0].url, "https://x.example/a");
  assert.equal(mapped.sources[0].snippet, "s");
});

test("mapSearchResult:content 不是 JSON 时原文透传、不硬造来源", () => {
  const mapped = mapSearchResult({
    content: [{ type: "text", text: "未找到相关结果" }],
  });
  assert.equal(mapped.content, "未找到相关结果");
  assert.equal(mapped.sources.length, 0);
});

test("mapSearchResult:无 text 块时返回空", () => {
  assert.deepEqual(mapSearchResult({ content: [] }), { content: "", sources: [], truncated: false });
  assert.deepEqual(mapSearchResult(undefined), { content: "", sources: [], truncated: false });
});

test("mapSearchResult:恒带 truncated=false(web_search 输出 schema 必填,0.1.2 实测缺失被宿主校验拒绝)", () => {
  const rows = [{ title: "t", link: "https://x.example/a", content: "s" }];
  const mapped = mapSearchResult({ content: [{ type: "text", text: JSON.stringify(rows) }] });
  assert.equal(mapped.truncated, false);
  const plain = mapSearchResult({ content: [{ type: "text", text: "未找到相关结果" }] });
  assert.equal(plain.truncated, false);
});

test("ZhipuMcpProvider:available 恒真;凭据缺失时 ready=false、search 报凭据错误", async () => {
  const ctx = { get: () => undefined };
  const provider = new ZhipuMcpProvider(() => ctx, { warn: () => {} });
  assert.equal(provider.available(), true);
  assert.equal(await provider.ready(), false);
  await assert.rejects(
    provider.search({ query: "测试" }),
    /no API key/,
  );
});

test("ZhipuMcpProvider:凭据可解析时 ready=true", async () => {
  const ctx = {
    get: (service) =>
      service === "credentials"
        ? { resolve: async (ref) => ({ value: "dummy-key", ref }) }
        : undefined,
  };
  const provider = new ZhipuMcpProvider(() => ctx, { warn: () => {} });
  assert.equal(await provider.ready(), true);
});

test("ZhipuMcpProvider:实例自带 id=PROVIDER_ID(宿主按 provider.id 建注册表,0.1.1 踩坑回归)", () => {
  const provider = new ZhipuMcpProvider(() => ({ get: () => undefined }), { warn: () => {} });
  assert.equal(provider.id, PROVIDER_ID);
  assert.equal(provider.id, "zhipu-mcp-search");
});

test("常量与官方实测对齐(工具名小写、端点、provider id、凭据名)", () => {
  assert.equal(MCP_TOOL, "web_search_prime");
  assert.equal(PROVIDER_ID, "zhipu-mcp-search");
  assert.equal(API_KEY_REF, "ZAI_CODING_CN_API_KEY");
  assert.equal(SEARCH_API_KEY_REF, "ZHIPU_WEB_SEARCH_API_KEY");
});

// ---- 0.2.0 专用 Key 回退链 ----

/**
 * 假凭据服务:按「包含匹配」映射凭据名 → 值,兼容裸名与品牌化引用两种形态。
 */
function fakeCredentials(map) {
  return {
    resolve: async (ref) => {
      const name = typeof ref === "string" ? ref : String(ref?.name ?? ref);
      for (const [key, value] of Object.entries(map)) {
        if (name === key || name.endsWith(key) || name.includes(key)) {
          return { value, ref };
        }
      }
      return undefined;
    },
  };
}

test("resolveProviderApiKey:专用 Key 存在时优先于共用 Key", async () => {
  const picked = await resolveProviderApiKey(
    fakeCredentials({ ZHIPU_WEB_SEARCH_API_KEY: "k-dedicated", ZAI_CODING_CN_API_KEY: "k-shared" }),
  );
  assert.equal(picked, "k-dedicated");
});

test("resolveProviderApiKey:专用 Key 缺失时回退共用 Key", async () => {
  const picked = await resolveProviderApiKey(
    fakeCredentials({ ZAI_CODING_CN_API_KEY: "k-shared" }),
  );
  assert.equal(picked, "k-shared");
});

test("resolveProviderApiKey:专用 Key 为空串按不存在处理(凭据服务空值语义)", async () => {
  const picked = await resolveProviderApiKey(
    fakeCredentials({ ZHIPU_WEB_SEARCH_API_KEY: "", ZAI_CODING_CN_API_KEY: "k-shared" }),
  );
  assert.equal(picked, "k-shared");
});

test("resolveProviderApiKey:两条链都没有时返回 undefined", async () => {
  assert.equal(await resolveProviderApiKey(fakeCredentials({})), undefined);
  assert.equal(await resolveProviderApiKey(undefined), undefined);
});

test("ZhipuMcpProvider:只设共用 Key 时 ready=true(0.2.0 回退链,零配置不破坏)", async () => {
  const ctx = {
    get: (service) =>
      service === "credentials"
        ? fakeCredentials({ ZAI_CODING_CN_API_KEY: "k-shared" })
        : undefined,
  };
  const provider = new ZhipuMcpProvider(() => ctx, { warn: () => {} });
  assert.equal(await provider.ready(), true);
});

test("ZhipuMcpProvider:两条链都缺失时 ready=false", async () => {
  const ctx = {
    get: (service) => (service === "credentials" ? fakeCredentials({}) : undefined),
  };
  const provider = new ZhipuMcpProvider(() => ctx, { warn: () => {} });
  assert.equal(await provider.ready(), false);
});
