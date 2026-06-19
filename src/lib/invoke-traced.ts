import { invoke } from "@tauri-apps/api/core";

/**
 * 带 trace_id 的 Tauri invoke 封装。
 *
 * - 若 args.trace_id 为合法非空字符串（调用方显式传入，用于一个操作内多次 invoke 关联），透传
 * - 否则自动生成 UUID v4
 * - trace_id 注入到 invoke 参数，后端 #[instrument] 通过同名参数捕获
 *
 * 合约约束：调用方传入的 trace_id 必须是合法 UUID v4 或 null/undefined。
 * 传入空字符串 "" 会被视为未提供（用 || 而非 ??，避免空串透传成无效值）。
 *
 * 用法：
 *   import { invokeTraced } from "@/lib/invoke-traced";
 *   const content = await invokeTraced<string>("read_file", { path });
 */
export async function invokeTraced<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  // 用 || 而非 ??：空字符串 "" 是 falsy，会触发自动生成，避免透传无效 trace_id。
  // trace_id 为 string 类型时，"" 是唯一需要防御的 falsy 值（不会出现 0/false）。
  // ⚠️ 传给 invoke 的 key 必须是 camelCase `traceId`：Tauri v2 把 Rust snake_case 参数
  // （trace_id）绑定为前端 camelCase（traceId）。若传 snake_case `trace_id`，Tauri 找不到
  // `traceId` → "missing required key traceId" → command 失败（如 list_directory 打不开项目）。
  const traceId = (args?.trace_id as string) || crypto.randomUUID();
  return invoke<T>(cmd, { ...args, traceId });
}
