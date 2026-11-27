import { executeToolBatch } from "./agent-pipeline.js"
import {
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  buildLayeredSystemPrompt,
  buildRuntimeContextReminder,
  compactChatHistory,
  computeContextBudget,
  pruneOldToolResults,
  retainHeadTailText,
} from "./agent-context.js"
import { RepeatToolGuard } from "./agent-guards.js"
import { parseRetryAfterMs, withLlmRetry } from "./llm-retry.js"
import { callProvider, providerCredentialsInMain, validateEndpointUrl } from "./provider-bridge.js"

export async function readSseEvents(body, onData) {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""
  let dataLines = []
  const flush = () => {
    if (!dataLines.length) return
    const payload = dataLines.join("\n").trim()
    dataLines = []
    if (payload && payload !== "[DONE]") onData(payload)
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) {
          flush()
          continue
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart())
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart())
    flush()
  } finally {
    reader.releaseLock?.()
  }
}

const geminiModelOptions = {
  auto: ["gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
  "gemini-3.1-flash-lite": ["gemini-3.1-flash-lite"],
  "gemini-3.5-flash-lite": ["gemini-3.5-flash-lite"],
}

export function buildSystemPrompt({
  allowEdits = true,
  allowWebSearch = true,
  planMode = false,
  sourceLanguage = "Japanese",
  targetLanguage = "Vietnamese",
  direction = "rtl",
  skillPrompt = "",
} = {}) {
  return buildLayeredSystemPrompt({
    allowEdits,
    allowWebSearch,
    planMode,
    sourceLanguage,
    targetLanguage,
    direction,
    skillPrompt,
  })
}

export function stripReasoning(raw) {
  const text = String(raw || "")
  const thoughts = []
  const cleaned = text
    .replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
      if (inner.trim()) thoughts.push(inner.trim())
      return ""
    })
    .trim()
  return { thought: thoughts.join("\n\n"), answer: cleaned }
}

// Text-form tool calls follow the OpenAI function-call convention, so `arguments` is often a
// JSON-encoded string emitted by local/quantized models. Decode it instead of dropping it.
function decodeToolArgs(value) {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" ? parsed : {}
    } catch {
      return {}
    }
  }
  return typeof value === "object" && value !== null ? value : {}
}

export function parseTextToolCalls(text) {
  const calls = []
  const pattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  let match
  while ((match = pattern.exec(String(text || ""))) !== null) {
    try {
      const parsed = JSON.parse(match[1])
      if (parsed && typeof parsed.name === "string") {
        calls.push({
          id: "tc_" + (calls.length + 1),
          name: parsed.name,
          args: decodeToolArgs(parsed.arguments),
        })
      }
    } catch {
      // Ignore malformed inline tool_call blocks.
    }
  }
  return calls
}

async function callGeminiStep({ settings, systemPrompt, contents, toolDefs, signal, stream = false, onDelta }) {
  const key = String(settings.key || "").trim()
  // On the desktop the key is read from the OS vault in main, so a missing settings value is not a
  // configuration error there: main answers with a credential error only when nothing is stored.
  if (!key && !providerCredentialsInMain()) throw new Error("Hãy nhập khóa API Gemini ở mục Dịch ảnh & LLM.")
  const models = geminiModelOptions[settings.model] ?? geminiModelOptions.auto
  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    ...(toolDefs.length && { tools: [{ functionDeclarations: toolDefs }] }),
  }
  let response
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    response = await callProvider({
      provider: "gemini",
      model,
      payload,
      key,
      stream,
      signal,
      timeoutMs: 90000,
    })
    if (response.ok) {
      const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase()
      const isSse = stream && contentType.includes("text/event-stream") && typeof response.body?.getReader === "function"
      const parts = []
      const textParts = []
      const thoughtParts = []
      const toolCalls = []
      let usage = null

      const ingestPayload = (payload) => {
        const meta = payload?.usageMetadata
        if (meta && (meta.promptTokenCount || meta.totalTokenCount)) {
          usage = {
            promptTokens: Number(meta.promptTokenCount || 0),
            outputTokens: Number(meta.candidatesTokenCount || 0),
            totalTokens: Number(meta.totalTokenCount || 0),
          }
        }
        const chunkParts = payload?.candidates?.[0]?.content?.parts ?? []
        for (const part of chunkParts) {
          parts.push(part)
          if (part.thought) {
            if (typeof part.text === "string" && part.text) {
              thoughtParts.push(part.text)
              onDelta?.({ text: "", thought: part.text })
            }
            continue
          }
          if (typeof part.text === "string" && part.text) {
            textParts.push(part.text)
            onDelta?.({ text: part.text, thought: "" })
          }
          if (part.functionCall?.name) {
            toolCalls.push({
              id: "gem_" + (toolCalls.length + 1) + "_" + Date.now(),
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
            })
          }
        }
      }

      if (isSse) {
        await readSseEvents(response.body, (raw) => {
          try {
            ingestPayload(JSON.parse(raw))
          } catch {
            // Ignore partial or non-JSON SSE keepalive frames.
          }
        })
      } else {
        ingestPayload(await response.json())
      }

      return {
        rawModelContent: { role: "model", parts },
        text: textParts.join(isSse ? "" : "\n").trim(),
        thought: thoughtParts.join("").trim(),
        toolCalls,
        usage,
      }
    }
    const canFallback = [404, 429, 500, 502, 503, 504].includes(response.status) && i + 1 < models.length
    if (!canFallback) break
  }
  const err = new Error(`Gemini trả lỗi ${response.status}. Kiểm tra khóa API và hạn mức.`)
  err.status = response.status
  err.retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"))
  throw err
}

async function callOpenAiStep({ settings, messages, toolDefs, signal, stream = false, onDelta }) {
  const endpoint = validateEndpointUrl(settings.baseUrl)
  const model = String(settings.llmModel || "").trim()
  if (!model) throw new Error("Hãy nhập tên Model LLM ở mục Dịch ảnh & LLM.")

  const body = {
    model,
    temperature: 0.3,
    messages,
    ...(stream && { stream: true, stream_options: { include_usage: true } }),
    ...(toolDefs.length && {
      tools: toolDefs.map((def) => ({
        type: "function",
        function: { name: def.name, description: def.description, parameters: def.parameters },
      })),
      tool_choice: "auto",
    }),
  }

  const response = await callProvider({
    provider: "openai",
    endpoint,
    payload: body,
    key: settings.apiKey,
    stream,
    signal,
    timeoutMs: 120000,
  })
  if (!response.ok) {
    const err = new Error(`LLM trả lỗi ${response.status}. Kiểm tra Base URL, tên model và API key.`)
    err.status = response.status
    err.retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"))
    throw err
  }

  const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase()
  const isSse = stream && contentType.includes("text/event-stream") && typeof response.body?.getReader === "function"

  if (isSse) {
    let rawText = ""
    let rawReasoning = ""
    let usage = null
    const toolMap = new Map()
    // OpenAI-compatible servers may omit `index` on streamed tool_call fragments (valid per
    // spec) or send `id` only on the first fragment. Alias both hints to a single slot so later
    // argument fragments keep accumulating instead of opening orphan slots that drop them.
    const toolAliases = new Map()
    let pendingKey = null
    const aliasKey = (hint, key) => {
      if (hint) toolAliases.set(hint, key)
    }
    const resolveToolKey = (item) => {
      const byId = item.id ? "id:" + item.id : ""
      const byIndex = Number.isInteger(item.index) ? "i:" + item.index : ""
      const known = (byId && toolAliases.get(byId)) || (byIndex && toolAliases.get(byIndex))
      if (known) return known
      return byId || byIndex || pendingKey || "tc:" + toolMap.size
    }
    await readSseEvents(response.body, (raw) => {
      let chunk
      try {
        chunk = JSON.parse(raw)
      } catch {
        return
      }
      if (chunk?.usage && (chunk.usage.prompt_tokens || chunk.usage.total_tokens)) {
        usage = {
          promptTokens: Number(chunk.usage.prompt_tokens || 0),
          outputTokens: Number(chunk.usage.completion_tokens || 0),
          totalTokens: Number(chunk.usage.total_tokens || 0),
        }
      }
      const delta = chunk?.choices?.[0]?.delta
      if (!delta) return
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        rawReasoning += delta.reasoning_content
        onDelta?.({ text: "", thought: delta.reasoning_content })
      }
      if (typeof delta.content === "string" && delta.content) {
        rawText += delta.content
        onDelta?.({ text: delta.content, thought: "" })
      }
      if (Array.isArray(delta.tool_calls)) {
        const seen = new Set()
        for (const item of delta.tool_calls) {
          let key = resolveToolKey(item)
          // Two hint-less fragments inside one delta are separate calls, never one continuation.
          if (!item.id && !Number.isInteger(item.index) && seen.has(key)) key = "tc:" + toolMap.size
          seen.add(key)
          aliasKey(item.id ? "id:" + item.id : "", key)
          aliasKey(Number.isInteger(item.index) ? "i:" + item.index : "", key)
          const prev = toolMap.get(key) ?? { order: toolMap.size, id: "", name: "", argumentsText: "" }
          if (item.id) prev.id = item.id
          if (item.function?.name) prev.name += item.function.name
          if (typeof item.function?.arguments === "string") prev.argumentsText += item.function.arguments
          toolMap.set(key, prev)
          pendingKey = key
        }
      }
    })
    let toolCalls = [...toolMap.values()]
      .sort((a, b) => a.order - b.order)
      .map((item, index) => {
        let args = {}
        try {
          args = JSON.parse(item.argumentsText || "{}")
        } catch {
          args = {}
        }
        return { id: item.id || "call_" + (index + 1), name: item.name, args }
      })
      .filter((tc) => tc.name)
    if (!toolCalls.length && rawText.includes("<tool_call>")) {
      toolCalls = parseTextToolCalls(rawText)
    }
    return {
      rawMessage: { role: "assistant", content: rawText },
      text: rawText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim(),
      thought: rawReasoning.trim(),
      toolCalls,
      usage,
    }
  }

  const payload = await response.json()
  const usage = payload?.usage && (payload.usage.prompt_tokens || payload.usage.total_tokens)
    ? {
      promptTokens: Number(payload.usage.prompt_tokens || 0),
      outputTokens: Number(payload.usage.completion_tokens || 0),
      totalTokens: Number(payload.usage.total_tokens || 0),
    }
    : null
  const message = payload.choices?.[0]?.message ?? {}
  const rawText = Array.isArray(message.content)
    ? message.content.filter((p) => p?.type === "text" && p.text).map((p) => p.text).join("\n")
    : String(message.content ?? "")
  const rawReasoning = typeof message.reasoning_content === "string" ? message.reasoning_content.trim() : ""

  let toolCalls = []
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    toolCalls = message.tool_calls.map((tc, index) => {
      let args = {}
      try {
        args = typeof tc.function?.arguments === "string"
          ? JSON.parse(tc.function.arguments || "{}")
          : (tc.function?.arguments ?? {})
      } catch {
        args = {}
      }
      return {
        id: tc.id || "call_" + (index + 1),
        name: tc.function?.name || "",
        args,
      }
    }).filter((tc) => tc.name)
  } else if (rawText.includes("<tool_call>")) {
    toolCalls = parseTextToolCalls(rawText)
  }

  return {
    rawMessage: message,
    text: rawText.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim(),
    thought: rawReasoning,
    toolCalls,
    usage,
  }
}

export async function summarizeHistoryWithLlm({ history = [], settings, keepRecentMessages = 4, signal } = {}) {
  const list = Array.isArray(history) ? history.filter((m) => m && typeof m.text === "string" && m.text.trim()) : []
  if (list.length <= keepRecentMessages + 1) {
    return compactChatHistory(list, { keepRecentMessages, force: true })
  }
  const totalChars = list.reduce((sum, m) => sum + m.text.length, 0)
  const older = list.slice(0, list.length - keepRecentMessages)
  const recent = list.slice(list.length - keepRecentMessages)
  const transcript = older
    .map((m) => `${m.role === "user" ? "Người dùng" : "Trợ lý"}: ${m.text.slice(0, 1000)}`)
    .join("\n\n")
  const directive = [
    "Hãy tóm tắt ngắn gọn bằng tiếng Việt đoạn hội thoại biên tập truyện tranh trên thành một mốc ngữ cảnh (checkpoint) để tiếp tục công việc không mất thông tin quan trọng.",
    "Giữ các mục ngắn dạng gạch đầu dòng: Mục tiêu chính, Tên nhân vật / Xưng hô & Thuật ngữ đã chốt, Các thay đổi đã làm, Việc còn dang dở.",
    "Chỉ xuất nội dung tóm tắt, không gọi công cụ.",
  ].join("\n")

  const isOpenAi = settings?.provider === "openai"
  const reply = isOpenAi
    ? await withLlmRetry(
      () => callOpenAiStep({
        settings,
        messages: [
          { role: "system", content: "Bạn là bộ nén ngữ cảnh cho trình biên tập truyện tranh Nixio." },
          { role: "user", content: `${transcript}\n\n---\n${directive}` },
        ],
        toolDefs: [],
        signal,
      }),
      { maxRetries: 1, signal },
    )
    : await withLlmRetry(
      () => callGeminiStep({
        settings,
        systemPrompt: "Bạn là bộ nén ngữ cảnh cho trình biên tập truyện tranh Nixio.",
        contents: [{ role: "user", parts: [{ text: `${transcript}\n\n---\n${directive}` }] }],
        toolDefs: [],
        signal,
      }),
      { maxRetries: 1, signal },
    )

  const summary = stripReasoning(reply.text).answer.trim()
  if (!summary) return compactChatHistory(list, { keepRecentMessages, force: true })
  const checkpointMessage = {
    role: "assistant",
    compacted: true,
    text: `${SUMMARY_OPEN_TAG}\n${summary}\n${SUMMARY_CLOSE_TAG}`,
  }
  const nextHistory = [checkpointMessage, ...recent]
  const nextChars = nextHistory.reduce((sum, m) => sum + m.text.length, 0)
  return {
    history: nextHistory,
    compacted: true,
    llmSummarized: true,
    foldedMessages: older.length,
    charsSaved: Math.max(0, totalChars - nextChars),
  }
}

export async function runAgentTurn({
  history = [],
  userMessage,
  settings,
  tools,
  allowEdits = true,
  allowWebSearch = true,
  planMode = false,
  confirmBulkEdits = true,
  skillPrompt = "",
  maxSteps = 10,
  maxRetries = 2,
  stream = false,
  signal,
  onEvent = () => {},
}) {
  const promptText = String(userMessage || "").trim()
  if (!promptText) throw new Error("Hãy nhập câu hỏi hoặc yêu cầu cho Trợ lý AI.")

  const turnStart = performance.now()
  const effectiveAllowEdits = Boolean(allowEdits) && !planMode
  const compacted = compactChatHistory(history)
  const workingHistory = compacted.history
  if (compacted.compacted) {
    onEvent({
      type: "compacted",
      foldedMessages: compacted.foldedMessages,
      charsSaved: compacted.charsSaved,
    })
  }

  const systemPrompt = buildSystemPrompt({
    allowEdits: effectiveAllowEdits,
    allowWebSearch,
    planMode,
    sourceLanguage: settings.source,
    targetLanguage: settings.target,
    direction: settings.direction,
    skillPrompt,
  })
  const providerLabel = settings.provider === "openai"
    ? (settings.llmModel || "OpenAI/Local")
    : `Gemini (${settings.model || "auto"})`
  const runtimeReminder = buildRuntimeContextReminder({
    snapshot: tools.getRuntimeSnapshot?.() ?? {},
    allowEdits: effectiveAllowEdits,
    allowWebSearch,
    planMode,
    providerLabel,
  })
  const toolDefs = tools.definitions({ allowEdits: effectiveAllowEdits, allowWebSearch, planMode })
  const isOpenAi = settings.provider === "openai"
  const toolTrace = []
  const thoughts = []
  const repeatGuard = new RepeatToolGuard()
  let totalPrunedChars = compacted.charsSaved
  let editsMade = 0
  let retriesUsed = 0
  // Set once this turn has pulled untrusted web content into the model context. From then on
  // every write is gated behind an explicit human approval, whatever confirmBulkEdits says.
  let webContentSeen = false

  // Build provider-specific message thread from clean chat history ({ role: "user"|"assistant", text }).
  const geminiContents = workingHistory.map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.text }],
  }))
  geminiContents.push({
    role: "user",
    parts: [{ text: `${runtimeReminder}\n\n${promptText}` }],
  })

  const openAiMessages = [
    { role: "system", content: systemPrompt },
    ...workingHistory.map((msg) => ({ role: msg.role, content: msg.text })),
    { role: "user", content: `${runtimeReminder}\n\n${promptText}` },
  ]

  let finalAnswer = ""
  let stepsUsed = 0
  let latestUsage = null
  let contextBudget = null

  for (let step = 1; step <= maxSteps; step++) {
    signal?.throwIfAborted()
    stepsUsed = step

    // Replay-safe old tool-result pruning between steps (inspired by DeepSeek Harness).
    if (step > 2) {
      const pruned = pruneOldToolResults(isOpenAi ? openAiMessages : geminiContents, {
        provider: isOpenAi ? "openai" : "gemini",
      })
      if (pruned.charsSaved > 0) {
        totalPrunedChars += pruned.charsSaved
        onEvent({ type: "pruned", prunedCount: pruned.prunedCount, charsSaved: pruned.charsSaved })
      }
    }

    onEvent({ type: "step", step, maxSteps })

    const onDelta = stream
      ? (delta) => onEvent({ type: "delta", step, text: delta.text || "", thought: delta.thought || "" })
      : undefined
    const reply = await withLlmRetry(
      () => (isOpenAi
        ? callOpenAiStep({ settings, messages: openAiMessages, toolDefs, signal, stream, onDelta })
        : callGeminiStep({ settings, systemPrompt, contents: geminiContents, toolDefs, signal, stream, onDelta })),
      {
        maxRetries,
        signal,
        onRetry({ attempt, maxRetries: limit, delayMs }) {
          retriesUsed++
          onEvent({ type: "retry", attempt, maxRetries: limit, delayMs })
        },
      },
    )

    signal?.throwIfAborted()
    if (reply.usage) latestUsage = reply.usage
    // openAiMessages already carries the system prompt as its first message; Gemini keeps it in
    // systemInstruction, outside contents. Count it once in either shape.
    const fallbackChars = JSON.stringify(isOpenAi ? openAiMessages : geminiContents).length
      + (isOpenAi ? 0 : systemPrompt.length)
    contextBudget = computeContextBudget({
      promptTokens: latestUsage?.promptTokens || 0,
      fallbackChars,
      provider: isOpenAi ? "openai" : "gemini",
      model: isOpenAi ? settings.llmModel : settings.model,
    })
    onEvent({ type: "usage", usage: latestUsage, budget: contextBudget })

    const { thought, answer } = stripReasoning(reply.text)
    if (reply.thought) thoughts.push(reply.thought)
    if (thought) thoughts.push(thought)

    if (!reply.toolCalls.length) {
      finalAnswer = answer || "Đã hoàn tất yêu cầu."
      onEvent({ type: "assistant", text: finalAnswer, thought: thoughts.join("\n\n") })
      break
    }

    if (isOpenAi) {
      openAiMessages.push({
        role: "assistant",
        content: reply.text || null,
        tool_calls: reply.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      })
    } else {
      geminiContents.push(reply.rawModelContent)
    }

    // A batch that itself reads the web must not be allowed to mutate in the same step.
    const batchReadsWeb = reply.toolCalls.some((call) => tools.categoryOf?.(call.name) === "web")
    const settled = await executeToolBatch(reply.toolCalls, {
      tools,
      allowEdits: effectiveAllowEdits,
      allowWebSearch,
      planMode,
      confirmBulkEdits,
      forceWriteApproval: webContentSeen || batchReadsWeb,
      maxParallel: 4,
      signal,
      onEvent,
    })

    const geminiResponses = []
    const openAiAttachments = []
    const guardReminders = []
    for (const entry of settled) {
      toolTrace.push(entry)
      if (entry.ok && entry.category === "web") webContentSeen = true
      if (entry.ok && entry.category === "write") editsMade++
      const guardHit = repeatGuard.observe(entry.name, entry.args)
      if (guardHit) {
        guardReminders.push(guardHit.reminder)
        onEvent({ type: "guard", toolName: guardHit.toolName, count: guardHit.count, level: guardHit.level })
      }

      const rawModelPayload = entry.ok
        ? (entry.modelText ?? JSON.stringify({ ok: true, summary: entry.summary, data: entry.data }))
        : JSON.stringify({ ok: false, error: entry.error, ...(entry.code && { code: entry.code }) })
      const retained = retainHeadTailText(rawModelPayload, {
        thresholdChars: 9000,
        headChars: 5400,
        tailChars: 2400,
      })
      if (retained.truncated) totalPrunedChars += retained.omittedChars

      if (isOpenAi) {
        openAiMessages.push({ role: "tool", tool_call_id: entry.id, content: retained.text })
        if (entry.ok && entry.attachment?.base64) {
          openAiAttachments.push({
            summary: entry.summary,
            mimeType: entry.attachment.mimeType || "image/jpeg",
            base64: entry.attachment.base64,
          })
        }
      } else {
        geminiResponses.push({
          functionResponse: {
            name: entry.name,
            response: entry.ok
              ? (entry.modelText || retained.truncated
                ? { ok: true, summary: entry.summary, content: retained.text }
                : { ok: true, summary: entry.summary, data: entry.data })
              : { ok: false, error: entry.error, ...(entry.code && { code: entry.code }) },
          },
        })
        if (entry.ok && entry.attachment?.base64) {
          geminiResponses.push({
            inlineData: {
              mimeType: entry.attachment.mimeType || "image/jpeg",
              data: entry.attachment.base64,
            },
          })
        }
      }
    }
    if (isOpenAi) {
      for (const att of openAiAttachments) {
        openAiMessages.push({
          role: "user",
          content: [
            { type: "text", text: `[Ảnh đính kèm từ inspect_page_image: ${att.summary}]` },
            { type: "image_url", image_url: { url: `data:${att.mimeType};base64,${att.base64}` } },
          ],
        })
      }
      for (const reminder of guardReminders) {
        openAiMessages.push({ role: "user", content: reminder })
      }
    } else {
      for (const reminder of guardReminders) {
        geminiResponses.push({ text: reminder })
      }
      geminiContents.push({ role: "user", parts: geminiResponses })
    }

    if (step === maxSteps) {
      finalAnswer = answer || `Đã thực hiện ${toolTrace.length} bước công cụ (đạt giới hạn ${maxSteps} bước). Bạn có thể nhắn tiếp để AI tiếp tục.`
      onEvent({ type: "assistant", text: finalAnswer, thought: thoughts.join("\n\n") })
    }
  }

  const updatedHistory = [
    ...workingHistory,
    { role: "user", text: promptText },
    { role: "assistant", text: finalAnswer },
  ].slice(-20)

  return {
    answer: finalAnswer,
    thought: thoughts.join("\n\n"),
    steps: stepsUsed,
    toolTrace,
    updatedHistory,
    editsMade,
    retriesUsed,
    prunedChars: totalPrunedChars,
    elapsedMs: Math.round(performance.now() - turnStart),
    usage: latestUsage,
    contextBudget,
    todos: tools.getTodos?.() ?? [],
    plan: tools.getPlan?.() ?? null,
  }
}
