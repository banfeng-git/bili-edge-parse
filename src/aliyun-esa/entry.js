/**
 * 阿里云 ESA（EdgeRoutine）边缘函数入口
 * 运行时模块形式：export default { async fetch(request, context, env) }
 */
import { createHandler } from "../core.js";

const { handleRequest } = createHandler();

export default {
  async fetch(request, context, env) {
    return handleRequest(request);
  },
};
