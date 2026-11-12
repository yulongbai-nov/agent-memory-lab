"use strict";
// Live-only proxy entry: caller provides short-lived environment credentials.
const { createBudgetProxy } = require("../harness-e2e/openai-proxy.cjs");
try {
  if (process.argv.length !== 2) throw Error("unexpected arguments");
  const proxy = createBudgetProxy({
    apiKey: process.env.MEMORY_LUNA_API_KEY,
    gateToken: process.env.MEMLAB_PROXY_TOKEN,
    requestLimit: 4,
    outputTokens: 384,
  });
  proxy.on("error", () => {
    console.error("proxy failed");
    process.exitCode = 1;
  });
  proxy.listen(8080, "127.0.0.1", () => console.log("restricted proxy ready"));
} catch {
  console.error("proxy configuration failed");
  process.exitCode = 1;
}
