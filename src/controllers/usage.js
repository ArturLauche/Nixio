// Token and cost panel for the chat sidebar (Nixio #65).
//
// The ledger owns the numbers; this module only turns a snapshot into the chip next to the chat
// status line and the price/budget editor. Prices are typed by the user, so the panel never claims a
// vendor rate it was not given.

import { formatTokens, formatUsd } from "../token-accounting.js"

const priceFields = [
  { key: "inputPerMTok", label: "Vào" },
  { key: "outputPerMTok", label: "Ra" },
  { key: "cachedPerMTok", label: "Cache" },
]

const budgetLevelCopy = {
  warn: {
    kind: "warning",
    title: "Sắp chạm hạn mức chi phí AI",
  },
  over: {
    kind: "error",
    title: "Đã vượt hạn mức chi phí AI",
  },
}

export function setupUsage({ byId, ledger, notify = () => {}, pageId = () => "" } = {}) {
  const chip = byId?.("chat-usage")
  const summaryEl = byId?.("usage-summary")
  const modelsEl = byId?.("usage-models")
  const limitInput = byId?.("usage-budget-limit")
  const warnInput = byId?.("usage-budget-warn")
  const resetBtn = byId?.("usage-reset")
  if (!ledger) return { refresh() {} }

  let lastLevel = "off"
  let renderedModels = ""

  function renderChip(state) {
    if (!chip) return
    const { totals, status } = state
    if (!totals.calls && !status.enabled) {
      chip.hidden = true
      chip.textContent = ""
      return
    }
    const parts = [`${formatTokens(totals.totalTokens)} token`, formatUsd(totals.costUsd)]
    if (status.enabled) parts.push(`${status.percent}% hạn mức`)
    chip.textContent = parts.join(" · ")
    chip.dataset.level = status.level
    chip.title = totals.unpricedCalls
      ? `${totals.unpricedCalls} lượt gọi chưa có giá trong bảng giá. Bấm “Kế toán token & chi phí” để nhập giá.`
      : "Tổng token và chi phí đã cộng dồn của dự án. Bấm “Kế toán token & chi phí” để xem chi tiết."
    chip.hidden = false
  }

  function renderSummary(state) {
    if (!summaryEl) return
    if (!state.totals.calls) {
      summaryEl.textContent = state.status.enabled
        ? `Chưa có lượt gọi AI nào. Hạn mức đang đặt: ${formatUsd(state.status.limitUsd)}.`
        : "Chưa có lượt gọi AI nào."
      return
    }
    const parts = [
      `Phiên này: ${formatTokens(state.session.totalTokens)} token · ${formatUsd(state.session.costUsd)}`,
      `Dự án: ${formatTokens(state.totals.totalTokens)} token · ${formatUsd(state.totals.costUsd)} (${state.totals.calls} lượt)`,
      `Trang này: ${formatTokens(state.page.totalTokens)} token`,
    ]
    parts.push(state.status.enabled
      ? `Hạn mức: ${formatUsd(state.status.spentUsd)}/${formatUsd(state.status.limitUsd)} (${state.status.percent}%)`
      : "Chưa đặt hạn mức chi phí")
    if (state.totals.unpricedCalls) parts.push(`${state.totals.unpricedCalls} lượt chưa có giá`)
    if (state.totals.estimatedCalls) parts.push(`${state.totals.estimatedCalls} lượt ước lượng`)
    summaryEl.textContent = parts.join(" · ")
  }

  function modelLabel(item) {
    return `${item.model} · ${formatTokens(item.totalTokens)} token${item.price ? "" : " · chưa đặt giá"}`
  }

  function renderModels(state) {
    if (!modelsEl) return
    // Rows are rebuilt only when the model set or its priced state changes: a live batch must not
    // replace the inputs the user is typing a price into.
    const signature = state.models.map((item) => `${item.key}:${item.price ? "p" : "-"}`).join("|")
    if (signature !== renderedModels) {
      renderedModels = signature
      modelsEl.replaceChildren(...state.models.map((item) => {
        const row = document.createElement("div")
        row.className = "usage-model"
        const name = document.createElement("span")
        name.className = "usage-model-name"
        const prices = document.createElement("div")
        prices.className = "usage-model-prices"
        const inputs = []
        for (const field of priceFields) {
          const label = document.createElement("label")
          label.textContent = field.label
          const input = document.createElement("input")
          input.type = "number"
          input.min = "0"
          input.step = "0.001"
          input.value = item.price ? String(item.price[field.key]) : ""
          input.placeholder = "0"
          input.setAttribute("aria-label", `${item.model} giá ${field.label} (USD trên 1 triệu token)`)
          input.onchange = () => {
            ledger.setPrice(item.provider, item.model, {
              inputPerMTok: inputs[0].value,
              outputPerMTok: inputs[1].value,
              cachedPerMTok: inputs[2].value,
            })
          }
          inputs.push(input)
          label.append(input)
          prices.append(label)
        }
        row.append(name, prices)
        return row
      }))
    }
    // The token count changes with every call, so the labels follow in place instead of a rebuild.
    state.models.forEach((item, index) => {
      const row = modelsEl.children?.[index]
      const name = row?.children?.[0]
      if (!name) return
      name.textContent = modelLabel(item)
      name.title = item.key
    })
  }

  function syncBudget(state) {
    const limit = String(state.budget.limitUsd || 0)
    const warn = String(state.budget.warnPercent)
    if (limitInput && limitInput.value !== limit) limitInput.value = limit
    if (warnInput && warnInput.value !== warn) warnInput.value = warn
  }

  function announceBudget(state) {
    const level = state.status.level
    if (level === lastLevel) return
    lastLevel = level
    const copy = budgetLevelCopy[level]
    if (!copy) return
    notify({
      kind: copy.kind,
      title: copy.title,
      message: level === "over"
        ? `Đã dùng ${formatUsd(state.status.spentUsd)} trên hạn mức ${formatUsd(state.status.limitUsd)}. Lượt gọi AI tiếp theo sẽ bị chặn cho tới khi bạn tăng hạn mức hoặc đặt lại kế toán token.`
        : `Đã dùng ${state.status.percent}% hạn mức (${formatUsd(state.status.spentUsd)}/${formatUsd(state.status.limitUsd)}). Lượt gọi AI sẽ bị chặn khi vượt hạn mức.`,
      key: "usage-budget",
    })
  }

  function refresh() {
    const state = ledger.snapshot({ pageId: pageId() })
    renderChip(state)
    renderSummary(state)
    renderModels(state)
    syncBudget(state)
    announceBudget(state)
    return state
  }

  if (limitInput) {
    limitInput.onchange = () => ledger.setBudget({
      limitUsd: Number(limitInput.value),
      warnPercent: Number(warnInput?.value),
    })
  }
  if (warnInput) {
    warnInput.onchange = () => ledger.setBudget({
      limitUsd: Number(limitInput?.value),
      warnPercent: Number(warnInput.value),
    })
  }
  if (resetBtn) {
    resetBtn.onclick = () => {
      ledger.reset()
      notify({
        kind: "info",
        title: "Đã đặt lại kế toán token",
        message: "Đã xóa số token và chi phí đã cộng dồn của dự án; bảng giá và hạn mức vẫn được giữ nguyên.",
        key: "usage-reset",
      })
    }
  }

  ledger.subscribe(refresh)
  refresh()
  return { refresh }
}
