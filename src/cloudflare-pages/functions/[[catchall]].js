/**
 * Cloudflare Pages Functions 入口（Catch-all）
 * 放到 Pages 项目根目录 functions/[[catchall]].js，请求进入 onRequest。
 */
import { createHandler } from "../../core.js";

const { handleRequest } = createHandler();

export async function onRequest(context) {
  return handleRequest(context.request);
}
