import assert from "node:assert/strict";

export const TRUNCATION_NOTE_FRAGMENT = "cut off at the model's max_tokens limit";

export async function withMockFetch(handlers, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const handler = handlers.shift();
    if (!handler) {
      throw new Error(`Unexpected fetch call to ${String(input)}`);
    }
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : undefined;
    calls.push({ input, init, bodyText });
    return handler(input, init);
  };

  try {
    await fn(calls);
    assert.equal(handlers.length, 0, "all mocked HTTP handlers should be consumed");
  } finally {
    globalThis.fetch = original;
  }
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonRequestBody(call) {
  assert.equal(typeof call.bodyText, "string");
  return JSON.parse(call.bodyText);
}

export function sseResponse(events) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function chatCompletion(content, finishReason = "stop") {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: finishReason,
      },
    ],
  };
}

export function chatCompletionStream(text, finishReason = "stop") {
  return sseResponse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finishReason }] })}\n\n`,
    "data: [DONE]\n\n",
  ]);
}

export function openAIResponse(outputText, incompleteReason = null) {
  return {
    id: "resp_test",
    object: "response",
    created_at: 1,
    status: incompleteReason ? "incomplete" : "completed",
    model: "test-model",
    output_text: outputText,
    output: [
      {
        id: "msg_test",
        type: "message",
        status: "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: outputText,
            annotations: [],
          },
        ],
      },
    ],
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    error: null,
  };
}

export function openAIResponseStream(text, incompleteReason = "max_output_tokens") {
  return sseResponse([
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`,
    `event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: openAIResponse(text, incompleteReason) })}\n\n`,
    "event: done\ndata: [DONE]\n\n",
  ]);
}

export function anthropicMessage(text, stopReason = "end_turn") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

export function anthropicStream(text, stopReason = "max_tokens") {
  return sseResponse([
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: anthropicMessage("", null) })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ]);
}

export function googleResponse(text, finishReason = "STOP") {
  return {
    candidates: [
      {
        content: { role: "model", parts: [{ text }] },
        finishReason,
      },
    ],
  };
}

export function googleStream(text, finishReason = "MAX_TOKENS") {
  return sseResponse([
    `data: ${JSON.stringify(googleResponse(text, undefined))}\n\n`,
    `data: ${JSON.stringify(googleResponse("", finishReason))}\n\n`,
  ]);
}
