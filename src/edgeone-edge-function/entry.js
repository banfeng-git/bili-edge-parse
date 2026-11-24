/**
 * 腾讯 EdgeOne 站点级边缘函数入口（Service Worker 风格）
 * 运行时仅支持 addEventListener('fetch', ...)，通过 event.respondWith 返回响应。
 * 控制台部署时使用内联后的 dist/edgeone-edge-function.js（单文件，无 import）。
 */
import { createHandler } from "../core.js";

const { handleRequest } = createHandler();

addEventListener("fetch", (event) => {
  event.respondWith(handleRequest(event.request));
});
