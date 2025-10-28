import type { Context } from "hono"

import consola from "consola"
import { streamSSE } from "hono/streaming"

import { awaitApproval } from "~/lib/approval"
import { recordRequest, recordTokenUsage } from "~/lib/metrics"
import { checkRateLimit } from "~/lib/rate-limit"
import { state } from "~/lib/state"
import {
  createChatCompletions,
  type ChatCompletionChunk,
  type ChatCompletionResponse,
} from "~/services/copilot/create-chat-completions"

import {
  type AnthropicMessagesPayload,
  type AnthropicStreamState,
} from "./anthropic-types"
import {
  translateToAnthropic,
  translateToOpenAI,
} from "./non-stream-translation"
import { translateChunkToAnthropicEvents } from "./stream-translation"

// Helper function to format duration as H:MM:SS
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
  }
  return `0:${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`
}

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  const startTime = Date.now()
  const anthropicPayload = await c.req.json<AnthropicMessagesPayload>()
  consola.debug("Anthropic request payload:", JSON.stringify(anthropicPayload))

  const openAIPayload = translateToOpenAI(anthropicPayload)
  consola.debug(
    "Translated OpenAI request payload:",
    JSON.stringify(openAIPayload),
  )

  if (state.manualApprove) {
    await awaitApproval()
  }

  const response = await createChatCompletions(openAIPayload)

  // Record request
  recordRequest(openAIPayload.model, "messages")

  if (isNonStreaming(response)) {
    consola.debug(
      "Non-streaming response from Copilot:",
      JSON.stringify(response).slice(-400),
    )

    // Record token usage for non-streaming responses
    if (response.usage) {
      const endTime = Date.now()
      const duration = (endTime - startTime) / 1000 // in seconds
      const speed =
        duration > 0 ? response.usage.completion_tokens / duration : 0
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19)
      const timeFormatted = formatDuration(duration)

      recordTokenUsage(
        response.model,
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
      )
      consola.info(
        `${timestamp} - INFO - Tokens (Anthropic) - Model: ${response.model}, In: ${response.usage.prompt_tokens}, Out: ${response.usage.completion_tokens}, Ctx: ${openAIPayload.max_tokens ?? "N/A"}, Time: ${timeFormatted}, Speed: ${speed.toFixed(2)} t/s`,
      )
    }

    const anthropicResponse = translateToAnthropic(response)
    consola.debug(
      "Translated Anthropic response:",
      JSON.stringify(anthropicResponse),
    )
    return c.json(anthropicResponse)
  }

  consola.debug("Streaming response from Copilot")

  // For streaming responses, we'll accumulate token counts
  let totalPromptTokens = 0
  let totalCompletionTokens = 0

  return streamSSE(c, async (stream) => {
    const streamState: AnthropicStreamState = {
      messageStartSent: false,
      contentBlockIndex: 0,
      contentBlockOpen: false,
      toolCalls: {},
    }

    for await (const rawEvent of response) {
      consola.debug("Copilot raw stream event:", JSON.stringify(rawEvent))
      if (rawEvent.data === "[DONE]") {
        break
      }

      if (!rawEvent.data) {
        continue
      }

      const chunk = JSON.parse(rawEvent.data) as ChatCompletionChunk

      // Extract usage information from chunks
      if (chunk.usage) {
        totalPromptTokens = chunk.usage.prompt_tokens
        totalCompletionTokens = chunk.usage.completion_tokens
      }

      const events = translateChunkToAnthropicEvents(chunk, streamState)

      for (const event of events) {
        consola.debug("Translated Anthropic event:", JSON.stringify(event))
        await stream.writeSSE({
          event: event.type,
          data: JSON.stringify(event),
        })
      }
    }

    // Record token usage after streaming completes
    if (totalPromptTokens > 0 || totalCompletionTokens > 0) {
      const endTime = Date.now()
      const duration = (endTime - startTime) / 1000 // in seconds
      const speed = duration > 0 ? totalCompletionTokens / duration : 0
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 19)
      const timeFormatted = formatDuration(duration)

      recordTokenUsage(
        openAIPayload.model,
        totalPromptTokens,
        totalCompletionTokens,
      )
      consola.info(
        `${timestamp} - INFO - Tokens (Anthropic streaming) - Model: ${openAIPayload.model}, In: ${totalPromptTokens}, Out: ${totalCompletionTokens}, Ctx: ${openAIPayload.max_tokens ?? "N/A"}, Time: ${timeFormatted}, Speed: ${speed.toFixed(2)} t/s`,
      )
    }
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
