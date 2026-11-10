// 端到端实弹:假宿主上下文 + 真凭据 + 真官方 MCP 一次搜索。
// 凭据从 DSH 凭据文件现取,不回显。运行:node scripts/e2e.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZhipuMcpProvider } from "../lib/index.js";

const credFile = join(homedir(), ".dsh", ".credentials.yaml");
const line = readFileSync(credFile, "utf8")
  .split(/\r?\n/)
  .find((row) => row.includes("ZAI_CODING_CN_API_KEY"));
if (line === undefined) {
  console.error("E2E_FAIL: 凭据文件里没有 ZAI_CODING_CN_API_KEY");
  process.exit(1);
}
const apiKey = line.split(":").slice(1).join(":").trim().replaceAll('"', "").replaceAll("'", "");
console.log(`key loaded: length=${apiKey.length}`);

// 假 ctx:credentials.resolve 接受任意引用(覆盖动态 import 失败后的裸名回退路径)
const ctx = {
  get: (service) =>
    service === "credentials"
      ? { resolve: async (ref) => ({ value: apiKey, ref }) }
      : undefined,
};

const provider = new ZhipuMcpProvider(() => ctx, { warn: (m) => console.warn("WARN:", m) });
console.log("available:", provider.available());
console.log("ready:", await provider.ready());

const started = Date.now();
const result = await provider.search({ query: "DeepSeek Harness 插件开发" }, undefined);
console.log(`search ok in ${Date.now() - started}ms`);
console.log("sources:", result.sources.length);
console.log("truncated:", result.truncated);
for (const source of result.sources.slice(0, 3)) {
  console.log(` - [${source.title}] ${source.url}`);
}
console.log("content preview:", result.content.slice(0, 220).replaceAll("\n", " | "));
