/**
 * 腾讯 EdgeOne Pages Functions 入口（Catch-all）
 * 放到 Pages 项目 edge-functions/[[default]].js，所有路径进入 onRequest。
 */
import { createHandler } from "../../core.js";

const { handleRequest } = createHandler();

export default async function onRequest({ request }) {
  return handleRequest(request);
}
