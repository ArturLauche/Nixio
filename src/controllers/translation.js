import { alignScript, translateImage } from "../gemini.js"
import {
  alignScriptOpenAi,
  translateImageOpenAi,
  validateEndpointUrl,
} from "../openai-compat.js"
import {
  remainingTranslations,
  translateBoxesForProvider,
  translationNotes,
  translationSignature,
} from "../translation.js"
import {
  boxStyleSignature,
  createTranslationMemoryStore,
  normalizeSourceText,
  translationMemoryScope,
} from "../translation-memory.js"
import { resolveSkillPrompt } from "../agent-skills.js"
import { groupDialogue } from "../io.js"
import { createCredentialSettings } from "../credential-settings.js"
import { PROVIDER_BRIDGE_CODES, providerCredentialsInMain } from "../provider-bridge.js"

const llmStorageKey = "khung-thoai-llm-config"
const llmPresets = {
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  lmstudio: { baseUrl: "http://localhost:1234/v1", model: "" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
}

export function setupTranslation({
  state,
  byId,
  status,
  checkpoint,
  renderPages,
  renderInspector,
  renderCanvas,
  render,
  selectedPage,
  pageForScript,
  applyTranslation,
  projectBusy,
  onSettingsChange,
  configWritesReady,
  notify,
  notifyOverflowIfAny,
  translationMemory,
}) {
  let translationController
  // The project owns the pairs; a caller that does not supply a store (tests, the browser panel
  // alone) still gets a working memory for this session.
  const memory = translationMemory ?? createTranslationMemoryStore()

  function loadStoredLlmConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(llmStorageKey) || "null")
      if (!saved || typeof saved !== "object") return
      if (saved.provider === "openai" || saved.provider === "gemini") {
        byId("translation-provider").value = saved.provider
      }
      if (typeof saved.baseUrl === "string" && saved.baseUrl) byId("llm-base-url").value = saved.baseUrl
      if (typeof saved.llmModel === "string") byId("llm-model").value = saved.llmModel
    } catch {
      // Ignore storage access errors in private browsing.
    }
  }

  // The startup migration erases plaintext keys from this record, so a write that landed before it
  // finished would put them back. Every write therefore waits for `configWritesReady`; the record
  // itself is captured when the user makes the change, not when the promise settles.
  const configReady = configWritesReady ? Promise.resolve(configWritesReady).catch(() => {}) : null

  function writeStoredLlmConfig(record) {
    const write = () => {
      try {
        localStorage.setItem(llmStorageKey, JSON.stringify(record))
      } catch {
        // Ignore storage access errors.
      }
    }
    if (!configReady) {
      write()
      return Promise.resolve()
    }
    return configReady.then(write, write)
  }

  function saveStoredLlmConfig() {
    return writeStoredLlmConfig({
      provider: byId("translation-provider").value,
      baseUrl: byId("llm-base-url").value.trim(),
      llmModel: byId("llm-model").value.trim(),
    })
  }

  function syncProviderFields() {
    const isOpenAi = byId("translation-provider").value === "openai"
    byId("gemini-fields").hidden = isOpenAi
    byId("openai-fields").hidden = !isOpenAi
  }

  // --- Credential vault (Nixio #60) ------------------------------------------------------------
  //
  // The password fields are write-only: a value typed here is handed to main once, on submit, and the
  // field is emptied before the answer arrives. No result, status or error ever carries a key back, so
  // nothing can prefill these inputs. A browser has no vault at all and keeps the value on screen for
  // this session only.
  const credentials = createCredentialSettings()
  // The vault controls need the three credential channels, which only the desktop preload exposes.
  const vaultOwnsKeys = credentials.available
  const credentialInputIds = { gemini: "gemini-key", openai: "llm-key" }
  const credentialStatusIds = { gemini: "gemini-key-status", openai: "llm-key-status" }
  const credentialRemoveIds = { gemini: "gemini-key-remove", openai: "llm-key-remove" }
  let boundScopeKey = null

  function credentialProvider() {
    return byId("translation-provider").value === "openai" ? "openai" : "gemini"
  }

  // Gemini has one fixed destination, so its key is bound to the provider alone; an OpenAI-compatible
  // key is bound to the exact Base URL that is on screen right now.
  function scopeEndpoint(provider) {
    return provider === "openai" ? byId("llm-base-url").value.trim() : undefined
  }

  function clearCredentialInputs() {
    for (const id of Object.values(credentialInputIds)) byId(id).value = ""
  }

  function clearCredentialStatus(provider) {
    const element = byId(credentialStatusIds[provider])
    element.textContent = ""
    element.dataset.error = "false"
    byId(credentialRemoveIds[provider]).disabled = true
  }

  function renderCredentialStatus(outcome) {
    const provider = outcome?.provider === "openai" || outcome?.provider === "gemini"
      ? outcome.provider
      : credentialProvider()
    const element = byId(credentialStatusIds[provider])
    element.textContent = outcome?.message || ""
    element.dataset.error = outcome?.ok === false ? "true" : "false"
    byId(credentialRemoveIds[provider]).disabled = outcome?.stored !== true
  }

  // The status line and a provider request both read these same two inputs, so the scope the screen
  // describes is the scope main binds the stored key to. Every question is issued with a sequence
  // number per provider and only the answer to the newest question is rendered: a scope probe issued
  // before a save would otherwise answer after it and replace "đã lưu khóa" with a plain status. The
  // call itself is made synchronously, so a save is bound to the scope that was on screen when the
  // user clicked, never to one they switched to while it was in flight.
  const credentialIssued = new Map()
  let credentialSequence = 0

  function issueCredential(provider, operation) {
    const sequence = ++credentialSequence
    credentialIssued.set(provider, sequence)
    return operation().then((outcome) => {
      // A superseded answer means the user already moved on, and the helper reports it without
      // claiming anything about the scope that is now on screen.
      if (credentialIssued.get(provider) === sequence && outcome?.superseded !== true) {
        renderCredentialStatus(outcome)
      }
      return outcome
    })
  }

  function bindCredentialScope(provider = credentialProvider(), { refresh = true } = {}) {
    const applied = credentials.setScope(provider, scopeEndpoint(provider))
    const scopeKey = applied.ok ? applied.scopeKey : null
    if (scopeKey !== boundScopeKey) {
      // A value typed for the previous provider or endpoint must not be saved under this one.
      clearCredentialInputs()
      for (const name of Object.keys(credentialStatusIds)) clearCredentialStatus(name)
      boundScopeKey = scopeKey
    }
    if (refresh) {
      // `refresh` still answers when the scope is unusable, so the status line explains why.
      void issueCredential(provider, () => credentials.refresh()).catch(() => {})
    }
    return applied
  }

  async function saveCredential(provider) {
    // Bind first: this is what clears a value that was typed for a different endpoint.
    const applied = bindCredentialScope(provider, { refresh: false })
    if (!applied.ok) return issueCredential(provider, () => credentials.refresh())
    const input = byId(credentialInputIds[provider])
    const secret = input.value
    // Emptied before the round trip, so a rejected save cannot leave the key in the field.
    input.value = ""
    return issueCredential(provider, () => credentials.save(secret))
  }

  async function removeCredential(provider) {
    const applied = bindCredentialScope(provider, { refresh: false })
    if (!applied.ok) return issueCredential(provider, () => credentials.refresh())
    return issueCredential(provider, () => credentials.remove())
  }

  function syncCredentialControls() {
    for (const id of ["gemini-key-actions", "llm-key-actions"]) byId(id).hidden = !vaultOwnsKeys
    for (const id of Object.values(credentialRemoveIds)) byId(id).disabled = true
  }

  loadStoredLlmConfig()
  syncProviderFields()
  syncCredentialControls()
  bindCredentialScope()

  byId("translation-provider").onchange = () => {
    syncProviderFields()
    bindCredentialScope()
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  byId("llm-preset").onchange = () => {
    const preset = llmPresets[byId("llm-preset").value]
    if (!preset) return
    byId("llm-base-url").value = preset.baseUrl
    if (preset.model && !byId("llm-model").value.trim()) byId("llm-model").value = preset.model
    bindCredentialScope()
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  byId("llm-base-url").onchange = () => {
    bindCredentialScope()
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  byId("llm-model").onchange = () => {
    saveStoredLlmConfig()
    onSettingsChange?.()
  }
  for (const provider of Object.keys(credentialInputIds)) {
    byId(credentialInputIds[provider] + "-save").onclick = () => saveCredential(provider)
    byId(credentialInputIds[provider] + "-remove").onclick = () => removeCredential(provider)
  }

  function readTranslationSettings() {
    const provider = byId("translation-provider").value
    return {
      provider,
      model: byId("gemini-model").value,
      baseUrl: byId("llm-base-url").value.trim(),
      llmModel: byId("llm-model").value.trim(),
      source: byId("source-language").value,
      target: byId("target-language").value,
      notes: byId("translation-notes").value.trim(),
      skillPrompt: resolveSkillPrompt(byId("chat-skill")?.value, byId("chat-skill-custom")?.value),
      direction: byId("direction").value,
      glossary: byId("translation-glossary").value.trim(),
    }
  }

  // --- Translation memory panel (Nixio #63) ----------------------------------------------------
  //
  // The panel only ever reports the store and offers the near matches for the page on screen. The
  // pairs themselves are applied by `translateExistingBoxes` below, so the count and the action here
  // describe the same store the translation path reads.
  function memoryScope() {
    return translationMemoryScope(readTranslationSettings())
  }

  // A plan is recomputed only when something that can change its answer changed: the store, the
  // page, or the text of its boxes. `render()` runs on every canvas frame, so this stays O(boxes).
  let memoryPlanKey = null
  let memoryPlan = { hits: [], suggestions: [], pending: [] }

  function pageMemoryPlan(page) {
    const settings = readTranslationSettings()
    const key = [
      memory.revision, page?.id ?? "", settings.source, settings.target, settings.glossary,
      (page?.boxes ?? []).map((box) => box.text).join("\u0000"),
    ].join("\u0001")
    if (key !== memoryPlanKey) {
      memoryPlanKey = key
      memoryPlan = page
        ? memory.plan(page.boxes, { scope: memoryScope(), page: page.name })
        : { hits: [], suggestions: [], pending: [] }
    }
    return memoryPlan
  }

  function syncMemory() {
    const summary = memory.summary(memoryScope())
    const page = selectedPage()
    const suggestions = page ? pageMemoryPlan(page).suggestions.length : 0
    byId("translation-memory-status").textContent = summary.total
      ? `Bộ nhớ dịch: ${summary.total} cặp đã lưu (${summary.reviewed} cặp đã duyệt)` +
        (suggestions ? ` · ${suggestions} gợi ý từ bộ nhớ cho trang này.` : ".")
      : "Bộ nhớ dịch: chưa có cặp nào trong dự án."
    const button = byId("use-approved-translation")
    button.disabled = !suggestions || projectBusy()
    button.textContent = suggestions ? `Dùng bản đã duyệt (${suggestions})` : "Dùng bản đã duyệt"
  }

  // Accepting a suggestion writes the pair into the boxes and records it as reviewed, so the next
  // identical line is reused without the provider ever being asked again.
  function useApprovedTranslation() {
    const page = selectedPage()
    if (!page || projectBusy()) return
    const plan = pageMemoryPlan(page)
    if (!plan.suggestions.length) return status("Không có bản gần đúng nào trong bộ nhớ dịch cho trang này.", true)
    checkpoint(undefined, { label: `Dùng bộ nhớ dịch cho trang ${page.name}`, kind: "translate" })
    const accepted = memory.accept(plan.suggestions, { scope: memoryScope(), page: page.name })
    const applied = memory.apply(plan.suggestions)
    status(`Đã dùng ${applied} bản từ bộ nhớ dịch cho trang ${page.name} và duyệt ${accepted.length} cặp.`)
    render()
  }

  // Main answers a request that has no stored credential through a fixed code, so the article status
  // stays Vietnamese while the renderer never repeats main's own wording or a raw provider header.
  function providerFailureText(error, provider) {
    if (error?.code === PROVIDER_BRIDGE_CODES.CREDENTIAL) {
      return provider === "gemini"
        ? "Chưa có khóa API Gemini trong kho bảo mật. Hãy lưu khóa ở mục Dịch ảnh & LLM."
        : "Chưa có khóa API cho endpoint này trong kho bảo mật. Hãy lưu khóa ở mục Dịch ảnh & LLM."
    }
    return error?.message || String(error)
  }

  function prepareCredentials(settings) {
    // On the desktop main attaches the stored key, so the password fields are never read for a
    // request: an unconfigured provider is rejected by main instead of by a value left on screen. A
    // browser has no vault and keeps using the field for this session only.
    const vaultKeys = vaultOwnsKeys || providerCredentialsInMain()
    if (settings.provider === "openai") {
      validateEndpointUrl(settings.baseUrl)
      if (!settings.llmModel) throw new Error("Hãy nhập tên Model LLM.")
      return vaultKeys ? settings : { ...settings, apiKey: byId("llm-key").value.trim() }
    }
    if (vaultKeys) return settings
    const key = byId("gemini-key").value.trim()
    if (!key) throw new Error("Hãy nhập khóa API Gemini.")
    return { ...settings, key }
  }

  async function processPages(pages, read, action, kind = "translate") {
    if (projectBusy() || !pages.length) return
    let settings
    try {
      settings = prepareCredentials(readTranslationSettings())
    } catch (error) {
      return status(error.message, true)
    }
    const signature = translationSignature(settings)
    const scope = translationMemoryScope(settings)
    const previousPage = state.pages[state.pages.indexOf(pages[0]) - 1]
    let context =
      previousPage?.translationContext?.signature === signature
        ? previousPage.translationContext.lines
        : []
    let completed = 0
    let placed = 0
    let skipped = 0
    checkpoint(undefined, { label: `Dịch ${pages.length} trang`, kind: "translate" })
    translationController = new AbortController()
    state.translating = true
    for (const page of pages)
      page.translationJob = { kind, signature, state: "pending" }
    renderPages()
    renderInspector()
    let activePage
    try {
      for (const page of pages) {
        activePage = page
        page.translationJob = { kind, signature, state: "running" }
        renderPages()
        const report = (message) => status(page.name + " · " + message)
        const lines = await read(page, {
          ...settings,
          notes: translationNotes(settings),
          context,
          report,
          signal: translationController.signal,
        })
        translationController.signal.throwIfAborted()
        if (lines.length) {
          placed += applyTranslation(page, lines)
          skipped += page.unplaced.length
          // Page translation learns the same pairs the box path does, so a later identical line is
          // already in the memory when the user asks for it there.
          for (const { source, text } of lines) {
            if (!source || !text) continue
            memory.record({ source, target: text }, { scope, page: page.name })
          }
          context = [
            ...context,
            ...lines
              .filter(({ source }) => source)
              .map(({ source, text }) => ({
                source: source.slice(0, 240),
                text: text.slice(0, 240),
              })),
          ].slice(-8)
        } else {
          page.unplaced = []
        }
        page.translationContext = { signature, lines: context }
        page.translationJob = { kind, signature, state: "done" }
        completed++
        if (selectedPage() === page) {
          renderCanvas()
          renderInspector()
        }
      }
      status(
        `Đã ${action} ${completed}/${pages.length} trang. ${placed} câu đã đặt và ${skipped} câu chờ đặt.`,
      )
      if (pages.length > 1) {
        notify?.({
          kind: "success",
          title: `Hoàn tất ${action} chương`,
          message: `Đã xử lý ${completed}/${pages.length} trang (${placed} câu đã đặt, ${skipped} câu chờ đặt).`,
          key: "batch-translate",
        })
      }
      const active = selectedPage()
      if (active && pages.includes(active)) notifyOverflowIfAny?.(active, "sau khi dịch")
    } catch (error) {
      const stopped = translationController.signal.aborted
      const reason = providerFailureText(error, settings.provider)
      if (activePage)
        activePage.translationJob = {
          kind,
          signature,
          state: stopped ? "pending" : "error",
          error: stopped ? undefined : reason,
        }
      status(
        stopped
          ? `Đã dừng sau ${completed} trang. Có thể tiếp tục dịch chương.`
          : `Đã ${action} ${completed}/${pages.length} trang. ${reason}`,
        !stopped,
      )
      if (!stopped && pages.length > 1) {
        notify?.({
          kind: "error",
          title: `Lỗi khi ${action} chương`,
          message: `Hoàn tất ${completed}/${pages.length} trang. ${reason}`,
          key: "batch-translate",
        })
      }
    } finally {
      state.translating = false
      translationController = null
      render()
    }
  }

  async function translateExistingBoxes() {
    const page = selectedPage()
    if (projectBusy() || !page) return
    if (!page.boxes.length) return status("Trang hiện tại chưa có khung chữ nào để dịch.", true)
    // A translation overwrites the source text, and the memory is keyed on exactly that text, so the
    // sources are read before anything writes to the boxes.
    const settingsInput = readTranslationSettings()
    const signature = translationSignature(settingsInput)
    const scope = translationMemoryScope(settingsInput)
    const sources = new Map(page.boxes.map((box) => [box.id, normalizeSourceText(box.text)]))
    const plan = memory.plan(page.boxes, { scope, page: page.name })
    // A page the memory already covers needs no key, no request and no spinner.
    if (!plan.pending.length) {
      checkpoint(undefined, { label: `Áp dụng bộ nhớ dịch cho trang ${page.name}`, kind: "translate" })
      const applied = memory.apply(plan.hits)
      page.translationJob = { kind: "translate", signature, state: "done" }
      status(`Đã dùng bộ nhớ dịch cho ${applied}/${page.boxes.length} khung chữ, không gọi API.`)
      render()
      return
    }
    let settings
    try {
      settings = prepareCredentials(settingsInput)
    } catch (error) {
      return status(error.message, true)
    }
    const reused = memory.apply(plan.hits)
    const previousPage = state.pages[state.pages.indexOf(page) - 1]
    const context =
      previousPage?.translationContext?.signature === signature
        ? previousPage.translationContext.lines
        : []
    checkpoint(undefined, { label: `Dịch trang ${page.name}`, kind: "translate" })
    translationController = new AbortController()
    state.translating = true
    page.translationJob = { kind: "translate", signature, state: "running" }
    renderPages()
    renderInspector()
    try {
      const report = (message) => status(page.name + " · " + message)
      const requestSettings = { ...settings, notes: translationNotes(settings), context, report, signal: translationController.signal }
      const translated = await translateBoxesForProvider(settings.provider, page, plan.pending, requestSettings)
      translationController.signal.throwIfAborted()
      const byBoxId = new Map(translated.map((item) => [item.boxId, item]))
      let updated = reused
      for (const box of plan.pending) {
        const match = byBoxId.get(box.id)
        if (!match?.text) continue
        box.text = match.text
        updated++
        // A provider answer is remembered unreviewed: it is offered next time, not trusted silently.
        memory.record(
          { source: sources.get(box.id) ?? "", target: match.text },
          { scope, page: page.name, style: boxStyleSignature(box) },
        )
      }
      page.translationContext = {
        signature,
        lines: [
          ...context,
          ...translated.map(({ source, text }) => ({
            source: source.slice(0, 240),
            text: text.slice(0, 240),
          })),
        ].slice(-8),
      }
      page.translationJob = { kind: "translate", signature, state: "done" }
      status(`Đã dịch ${updated}/${page.boxes.length} khung chữ trên trang` +
        (reused ? `, dùng lại ${reused} cặp từ bộ nhớ dịch` : "") + ".")
      notifyOverflowIfAny?.(page, "sau khi dịch khung chữ")
    } catch (error) {
      const stopped = translationController.signal.aborted
      const reason = providerFailureText(error, settings.provider)
      page.translationJob = {
        kind: "translate",
        signature,
        state: stopped ? "pending" : "error",
        error: stopped ? undefined : reason,
      }
      status(stopped ? "Đã dừng dịch khung chữ." : "Không dịch được khung chữ. " + reason, !stopped)
    } finally {
      state.translating = false
      translationController = null
      render()
    }
  }

  const imageTranslator = (page, settings) =>
    settings.provider === "openai" ? translateImageOpenAi(page, settings) : translateImage(page, settings)
  const scriptAligner = (page, settings, lines) =>
    settings.provider === "openai" ? alignScriptOpenAi(page, settings, lines) : alignScript(page, settings, lines)

  byId("translate-boxes").onclick = translateExistingBoxes
  byId("use-approved-translation").onclick = useApprovedTranslation
  byId("translate").onclick = () =>
    processPages([selectedPage()].filter(Boolean), imageTranslator, "dịch")
  byId("translate-all").onclick = () =>
    processPages([...state.pages], imageTranslator, "dịch")
  byId("resume-translation").onclick = () =>
    processPages(
      remainingTranslations(state.pages, readTranslationSettings()),
      imageTranslator,
      "dịch",
    )
  byId("stop-translation").onclick = () => translationController?.abort()
  byId("align-script").onclick = () => {
    const page = selectedPage()
    if (!page) return
    const lines = groupDialogue(byId("script-text").value)
      .filter(({ reference }) => pageForScript(reference, page) === page)
      .flatMap(({ lines }) => lines)
    if (!lines.length) return status("Hãy nhập kịch bản cho trang này.", true)
    processPages(
      [page],
      (selected, settings) => scriptAligner(selected, settings, lines),
      "ghép",
      "align",
    )
  }

  syncMemory()

  return { settings: readTranslationSettings, syncMemory }
}
