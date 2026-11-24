/**
 * Cloudflare Workers 模块入口（Module Worker）
 * 部署：wrangler deploy，或控制台粘贴 dist/cloudflare-worker.js
 */
import { createHandler } from "../core.js";

const { handleRequest } = createHandler();

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request);
  },
};
