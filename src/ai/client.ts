import "dotenv/config";
import OpenAI from "openai";

import { SYSTEM_PROMPT } from "./prompt.js";

const apiKey =
    process.env.CODEX_API_KEY;

const baseURL =
    process.env.CODEX_BASE_URL;

if (!apiKey || !baseURL) {
    throw new Error(
        "缺少 CODEX_API_KEY 或 CODEX_BASE_URL",
    );
}

const client = new OpenAI({
    apiKey,
    baseURL,
});

interface ChatOptions {
    onWebSearchStart?:
        () => void | Promise<void>;

    /*
     * 只有明确需要识图时才传。
     * 默认不携带图片。
     */
    imageUrls?: string[];
}

export async function chat(
    input: string,
    options: ChatOptions = {},
): Promise<string> {
    console.log(
        "[AI] 准备请求：",
        input,
    );

    const startedAt = Date.now();

    /*
     * 没图片时仍然保持最简单的纯文本请求。
     * 有图片时才构造 Responses 多模态 input。
     */
    const requestInput: any =
        options.imageUrls &&
        options.imageUrls.length > 0
            ? [
                  {
                      role: "user",
                      content: [
                          {
                              type: "input_text",
                              text: input,
                          },
                          ...options.imageUrls.map(
                              (url) => ({
                                  type: "input_image",
                                  image_url: url,
                              }),
                          ),
                      ],
                  },
              ]
            : input;

    const stream =
        await client.responses.create({
            model: "gpt-6-sol",

            instructions:
                SYSTEM_PROMPT,

            input: requestInput,

            reasoning: {
                effort: "medium",
            },

            text: {
                verbosity: "medium",
            },

            /*
             * 始终把 web_search 能力交给模型，
             * 是否真正搜索由 tool_choice:auto 决定。
             */
            tools: [
                {
                    type: "web_search",
                },
            ],

            tool_choice: "auto",

            store: false,
            stream: true,
        });

    console.log(
        `[AI] 已建立响应流 ${
            Date.now() - startedAt
        }ms`,
    );

    let output = "";
    let searchNoticeSent = false;

    for await (const event of stream) {
        if (
            event.type ===
                "response.web_search_call.searching" &&
            !searchNoticeSent
        ) {
            searchNoticeSent = true;

            console.log(
                "[AI] 开始联网搜索",
            );

            await options
                .onWebSearchStart?.();
        }

        if (
            event.type ===
            "response.output_text.delta"
        ) {
            output += event.delta;
        }

        if (
            event.type ===
            "response.failed"
        ) {
            throw new Error(
                `模型请求失败：${JSON.stringify(
                    event.response.error,
                )}`,
            );
        }
    }

    console.log(
        "[AI] 完成：",
        output,
    );

    if (!output.trim()) {
        throw new Error(
            "模型没有返回文本",
        );
    }

    return output.trim();
}
