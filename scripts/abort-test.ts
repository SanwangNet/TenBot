import OpenAI from "openai";
import "dotenv/config";

const apiKey = process.env.CODEX_API_KEY;
const baseURL = process.env.CODEX_BASE_URL;

if (!apiKey) {
  throw new Error("Missing CODEX_API_KEY");
}

if (!baseURL) {
  throw new Error("Missing CODEX_BASE_URL");
}

const client = new OpenAI({
  apiKey,
  baseURL,
  maxRetries: 0,
  timeout: 120_000,
});

const controller = new AbortController();

const startedAt = Date.now();
let responseId: string | undefined;
let firstOutputAt: number | undefined;
let abortTimer: NodeJS.Timeout | undefined;

function elapsed() {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

function abort(reason: string) {
  if (controller.signal.aborted) return;

  console.log(`\n[TEST] abort at ${elapsed()}s: ${reason}`);
  controller.abort();
}

// 防止后端一直不开始输出。
// 25 秒还没有 output delta，也直接掐掉。
const safetyTimer = setTimeout(() => {
  abort("25s safety timeout");
}, 25_000);

console.log("[TEST] starting request...");
console.log(`[TEST] baseURL=${baseURL}`);
console.log("[TEST] maxRetries=0");
console.log("[TEST] will abort 1.5s after first output delta");

try {
  const stream = client.responses.stream(
    {
      model: "gpt-6-sol",
      reasoning: {
        effort: "medium",
      },
      tools: [
        {
          type: "web_search",
        },
      ],
      tool_choice: "auto",
      max_output_tokens: 2500,
      input: `
请使用联网搜索研究“2026 年近期 AI 编程工具的发展趋势”。

要求：
- 必须联网搜索
- 至少参考多个来源
- 最后给出较详细的中文总结
- 不要过早结束回答
      `.trim(),
    },
    {
      signal: controller.signal,
    },
  );

  for await (const event of stream) {
    if (event.type === "response.created") {
      responseId = event.response.id;
      console.log(
        `[TEST] response created at ${elapsed()}s id=${responseId}`,
      );
      continue;
    }

    if (
      event.type === "response.web_search_call.in_progress" ||
      event.type === "response.web_search_call.searching" ||
      event.type === "response.web_search_call.completed"
    ) {
      console.log(`[TEST] ${event.type} at ${elapsed()}s`);
      continue;
    }

    if (event.type === "response.output_text.delta") {
      if (!firstOutputAt) {
        firstOutputAt = Date.now();

        console.log(
          `\n[TEST] first output delta at ${elapsed()}s`,
        );

        // 确认模型已经开始生成后，再让它生成一小会。
        abortTimer = setTimeout(() => {
          abort("1.5s after first output delta");
        }, 1500);
      }

      // 不打印真实正文，只打印一点点进度，避免终端刷屏。
      process.stdout.write(".");
    }

    if (event.type === "response.completed") {
      console.log(`\n[TEST] response completed at ${elapsed()}s`);
    }
  }

  console.log(`\n[TEST] stream ended normally at ${elapsed()}s`);
} catch (error) {
  if (controller.signal.aborted) {
    console.log(`[TEST] request aborted locally at ${elapsed()}s`);
  } else {
    console.error("[TEST] request failed:", error);
    process.exitCode = 1;
  }
} finally {
  clearTimeout(safetyTimer);

  if (abortTimer) {
    clearTimeout(abortTimer);
  }

  console.log(`[TEST] responseId=${responseId ?? "unknown"}`);
  console.log(`[TEST] total local lifetime=${elapsed()}s`);
}