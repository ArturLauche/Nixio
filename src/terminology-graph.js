import { normalizedSearch } from "./io.js"

// The glossary lives in a single text field of the project, so the graph is stored as text
// too: every term keeps the canonical "source = target" line that prompts, older projects
// and older readers understand, and "@" directives carry the fields a flat pair cannot
// express (aliases, variants, part of speech, keep flag, preferred/forbidden renderings and
// typed relations). Reading is tolerant, writing is canonical, so a legacy glossary survives
// a round trip unchanged.
export const partsOfSpeech = ["term", "name", "honorific", "noun", "phrase", "verb", "adjective", "adverb", "interjection"]
export const relationTypes = ["broader", "narrower", "related", "conflict"]
const inverseRelation = { broader: "narrower", narrower: "broader", related: "related", conflict: "conflict" }
const defaultPartOfSpeech = "term"
const directiveLine = /^@(\p{L}+)(?:\s+(.*))?$/u
const surfaceDirectives = { alias: "aliases", variant: "variants", prefer: "preferred", forbid: "forbidden" }

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function keyOf(value) {
  return normalizedSearch(cleanText(value))
}

function uniqueSurfaces(values) {
  const out = []
  const seen = new Set()
  for (const value of values ?? []) {
    const text = cleanText(value)
    const key = keyOf(text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}

function problem(line, message) {
  return { line, message }
}

// A term is normalised in one place so parsing, merging and formatting all agree on what
// "accepted" versus "forbidden" means: a preferred rendering can never be a variant, and
// neither can be forbidden. Part of speech and the keep flag fall back to their defaults.
function normalizeTerm(raw) {
  const source = cleanText(raw?.source)
  const target = cleanText(raw?.target)
  if (!source || !target) return null
  const preferred = uniqueSurfaces([target, ...(raw.preferred ?? [])])
  const preferredKeys = new Set(preferred.map(keyOf))
  const variants = uniqueSurfaces(raw.variants).filter((value) => !preferredKeys.has(keyOf(value)))
  const variantKeys = new Set(variants.map(keyOf))
  const forbidden = uniqueSurfaces(raw.forbidden).filter((value) => !preferredKeys.has(keyOf(value)) && !variantKeys.has(keyOf(value)))
  const aliases = uniqueSurfaces(raw.aliases).filter((value) => keyOf(value) !== keyOf(source))
  const relations = Object.fromEntries(
    relationTypes.map((type) => [type, uniqueSurfaces(raw.relations?.[type])]),
  )
  return {
    id: "",
    source,
    target,
    aliases,
    variants,
    partOfSpeech: partsOfSpeech.includes(raw.partOfSpeech) ? raw.partOfSpeech : defaultPartOfSpeech,
    translate: raw.translate !== false,
    preferred,
    forbidden,
    relations,
  }
}

function mergeRawTerm(term, patch) {
  const merged = {
    source: term.source,
    target: patch.target ? cleanText(patch.target) : term.target,
    aliases: [...(term.aliases ?? []), ...(patch.aliases ?? [])],
    variants: [...(term.variants ?? []), ...(patch.variants ?? [])],
    preferred: [...(term.preferred ?? []), ...(patch.preferred ?? [])],
    forbidden: [...(term.forbidden ?? []), ...(patch.forbidden ?? [])],
    partOfSpeech: patch.partOfSpeech ?? term.partOfSpeech,
    translate: patch.translate === undefined ? term.translate : patch.translate !== false,
    relations: Object.fromEntries(
      relationTypes.map((type) => [
        type,
        [...(term.relations?.[type] ?? []), ...(patch.relations?.[type] ?? [])],
      ]),
    ),
  }
  Object.assign(term, merged)
}

function applyDirective(term, keyword, value, problems, line) {
  if (keyword === "keep" || keyword === "translate") {
    term.translate = keyword === "translate"
    return
  }
  if (keyword === "pos") {
    if (!partsOfSpeech.includes(value)) {
      problems.push(problem(line, `Dạng từ "${value}" không hỗ trợ; dùng một trong: ${partsOfSpeech.join(", ")}.`))
      return
    }
    term.partOfSpeech = value
    return
  }
  const field = surfaceDirectives[keyword]
  if (field) {
    if (!value) {
      problems.push(problem(line, `Chỉ thị "@${keyword}" thiếu nội dung.`))
      return
    }
    term[field].push(value)
    return
  }
  if (relationTypes.includes(keyword)) {
    if (!value) {
      problems.push(problem(line, `Quan hệ "@${keyword}" thiếu thuật ngữ đích.`))
      return
    }
    if (!term.relations[keyword]) term.relations[keyword] = []
    term.relations[keyword].push(value)
    return
  }
  problems.push(problem(line, `Chỉ thị "@${keyword}" không được hỗ trợ.`))
}

function findTermIn(terms, ref) {
  const key = keyOf(ref)
  const raw = cleanText(ref)
  if (!key) return null
  return terms.find((term) => term.id && term.id === raw)
    ?? terms.find((term) => keyOf(term.source) === key)
    ?? terms.find((term) => term.aliases.some((alias) => keyOf(alias) === key))
    ?? terms.find((term) => keyOf(term.target) === key)
    ?? terms.find((term) => term.preferred.some((value) => keyOf(value) === key) || term.variants.some((value) => keyOf(value) === key))
    ?? terms.find((term) => term.forbidden.some((value) => keyOf(value) === key))
    ?? null
}

function uniqueId(source, used) {
  const base = keyOf(source).replace(/\s+/g, "-") || "thuat-ngu"
  let id = base
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`
  used.add(id)
  return id
}

// Related terms are named by any of their surfaces in the text, but the graph stores ids, so
// one declared edge becomes two: the relation itself and its inverse on the other term. That
// is what keeps broader/narrower, related and conflict symmetric however they were written.
function resolveRelations(terms, problems) {
  const edges = new Map(terms.map((term) => [term.id, Object.fromEntries(relationTypes.map((type) => [type, new Set()]))]))
  for (const term of terms) {
    for (const type of relationTypes) {
      for (const ref of term.relations[type] ?? []) {
        const target = findTermIn(terms, ref)
        if (!target) {
          problems.push(problem(0, `Không tìm thấy thuật ngữ "${ref}" cho quan hệ ${type} của "${term.source}".`))
          continue
        }
        if (target.id === term.id) continue
        edges.get(term.id)[type].add(target.id)
        edges.get(target.id)[inverseRelation[type]].add(term.id)
      }
    }
  }
  for (const term of terms) {
    term.relations = Object.fromEntries(
      relationTypes.map((type) => [type, [...edges.get(term.id)[type]].sort()]),
    )
  }
}

function buildGraph(rawTerms, problems) {
  const merged = []
  const bySource = new Map()
  for (const raw of rawTerms) {
    if (!cleanText(raw?.source) || !cleanText(raw?.target)) continue
    const key = keyOf(raw.source)
    const existing = bySource.get(key)
    if (existing) {
      mergeRawTerm(existing, raw)
      problems.push(problem(0, `Mục "${cleanText(raw.source)}" bị trùng trong bảng; đã gộp thành một mục.`))
      continue
    }
    const copy = {
      source: cleanText(raw.source),
      target: cleanText(raw.target),
      aliases: [...(raw.aliases ?? [])],
      variants: [...(raw.variants ?? [])],
      preferred: [...(raw.preferred ?? [])],
      forbidden: [...(raw.forbidden ?? [])],
      partOfSpeech: raw.partOfSpeech,
      translate: raw.translate,
      relations: Object.fromEntries(relationTypes.map((type) => [type, [...(raw.relations?.[type] ?? [])]])),
    }
    bySource.set(key, copy)
    merged.push(copy)
  }
  const terms = merged.map(normalizeTerm).filter(Boolean)
  const used = new Set()
  for (const term of terms) term.id = uniqueId(term.source, used)
  resolveRelations(terms, problems)
  return { terms, problems }
}

export function parseTerminologyGraph(glossaryText) {
  const problems = []
  const rawTerms = []
  let current = null
  let lineNumber = 0
  for (const rawLine of String(glossaryText ?? "").split(/\r?\n/)) {
    lineNumber++
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith("//")) continue
    const directive = line.match(directiveLine)
    if (directive) {
      if (!current) {
        problems.push(problem(lineNumber, `Chỉ thị "${line}" không thuộc mục thuật ngữ nào.`))
        continue
      }
      applyDirective(current, directive[1].toLowerCase(), cleanText(directive[2]), problems, lineNumber)
      continue
    }
    const separator = line.includes("=") ? "=" : line.includes("->") ? "->" : line.includes(":") ? ":" : null
    const index = separator ? line.indexOf(separator) : -1
    const source = index < 0 ? "" : cleanText(line.slice(0, index))
    const target = index < 0 ? "" : cleanText(line.slice(index + separator.length))
    if (!source || !target) {
      problems.push(problem(lineNumber, `Dòng "${line.slice(0, 40)}" không theo dạng "nguồn = dịch".`))
      current = null
      continue
    }
    current = { source, target, aliases: [], variants: [], preferred: [], forbidden: [], relations: {} }
    rawTerms.push(current)
  }
  return buildGraph(rawTerms, problems)
}

export function findTerm(graph, ref) {
  return findTermIn(graph?.terms ?? [], ref)
}

// Accepted renderings of one term, used by the resolver and by the QA checks. A term marked
// "keep" accepts its own source form as the rendering, and never demands a translation.
export function termRenderings(term) {
  const preferred = uniqueSurfaces([term?.target, ...(term?.preferred ?? [])])
  const preferredKeys = new Set(preferred.map(keyOf))
  const variants = uniqueSurfaces(term?.variants).filter((value) => !preferredKeys.has(keyOf(value)))
  const variantKeys = new Set(variants.map(keyOf))
  const forbidden = uniqueSurfaces(term?.forbidden).filter((value) => !preferredKeys.has(keyOf(value)) && !variantKeys.has(keyOf(value)))
  const accepted = uniqueSurfaces([...preferred, ...variants, ...(term?.translate === false && term?.source ? [term.source] : [])])
  const translationRequired = Boolean(term?.translate !== false && term?.source)
    && cleanText(term.source).length >= 2
    && keyOf(term.source) !== keyOf(term.target)
  return { preferred, variants, forbidden, accepted, translationRequired }
}

export function termSummary(term, graph) {
  if (!term) return null
  const byId = new Map((graph?.terms ?? []).map((item) => [item.id, item]))
  return {
    id: term.id,
    source: term.source,
    target: term.target,
    aliases: [...term.aliases],
    variants: [...term.variants],
    partOfSpeech: term.partOfSpeech,
    translate: term.translate,
    preferred: [...term.preferred],
    forbidden: [...term.forbidden],
    relations: Object.fromEntries(
      relationTypes.map((type) => [type, term.relations[type].map((id) => byId.get(id)?.source).filter(Boolean)]),
    ),
  }
}

// Folding the line character by character keeps a link from a normalised match back to the
// position in the original text, so two terms of one line can be ordered by where they appear.
function foldedIndex(text) {
  let folded = ""
  const origin = []
  for (let index = 0; index < text.length; index++) {
    const piece = text[index].normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replaceAll("đ", "d")
    for (const _ of piece) origin.push(index)
    folded += piece
  }
  return { folded, origin }
}

function locateSurface(text, surface) {
  const needle = keyOf(surface)
  if (!needle) return { index: -1, matched: "" }
  const { folded, origin } = foldedIndex(text)
  const wholeWord = /^[a-z0-9][a-z0-9 ._-]*$/.test(needle)
  for (let from = 0; from <= folded.length - needle.length; from++) {
    if (!folded.startsWith(needle, from)) continue
    if (wholeWord) {
      const before = folded[from - 1] ?? " "
      const after = folded[from + needle.length] ?? " "
      if (/[a-z0-9_]/.test(before) || /[a-z0-9_]/.test(after)) continue
    }
    return { index: origin[from], matched: text.slice(origin[from], origin[from + needle.length - 1] + 1).trim() }
  }
  return { index: -1, matched: "" }
}

const matchRank = { source: 0, alias: 1, preferred: 2, variant: 3, forbidden: 4 }

// Why the term applied, in the words the editor and the model both read.
function matchReason(term, kind, matched) {
  if (kind === "source" || kind === "alias") {
    if (term.translate === false) return `Giữ nguyên "${term.source}", không dịch.`
    return kind === "source"
      ? `Khớp nguồn "${matched}" → dịch thành "${term.target}".`
      : `Khớp biến thể nguồn "${matched}" của "${term.source}" → dịch thành "${term.target}".`
  }
  if (kind === "preferred") return `Đã dùng đúng bản dịch ưu tiên "${matched}".`
  if (kind === "variant") return `"${matched}" là biến thể được chấp nhận; chuẩn hoá về "${term.target}".`
  return `"${matched}" là dạng bị cấm; phải dùng "${term.target}".`
}

function bestMatch(term, text, targetSide) {
  const renderings = termRenderings(term)
  const candidates = [
    { kind: "source", surfaces: [term.source] },
    { kind: "alias", surfaces: term.aliases },
  ]
  if (targetSide) {
    candidates.push(
      { kind: "preferred", surfaces: renderings.preferred },
      { kind: "variant", surfaces: renderings.variants },
      { kind: "forbidden", surfaces: renderings.forbidden },
    )
  }
  const found = []
  for (const candidate of candidates) {
    for (const surface of candidate.surfaces) {
      const hit = locateSurface(text, surface)
      if (hit.index < 0) continue
      found.push({ kind: candidate.kind, index: hit.index, matched: hit.matched || surface, length: keyOf(surface).length })
    }
  }
  // Within one term the longer surface wins: the variant "Thầy giáo" is not the preferred
  // "Thầy" plus noise, it is the form the line actually used.
  const kept = found.filter((hit) => !found.some((other) => other !== hit
    && other.index <= hit.index
    && other.index + other.length >= hit.index + hit.length
    && (other.index < hit.index || other.length > hit.length)))
  let best = null
  for (const next of kept) {
    if (!best || matchRank[next.kind] < matchRank[best.kind]
      || (matchRank[next.kind] === matchRank[best.kind] && next.index < best.index)
      || (matchRank[next.kind] === matchRank[best.kind] && next.index === best.index && next.length > best.length)) {
      best = next
    }
  }
  return best
}

// Given one line and the project's language pair, list the terms that apply. A source line
// is matched on the source side; target-side renderings are matched too so the same call
// answers QA questions (forbidden forms, accepted variants). Same source and target language
// means there is no target side to match.
export function resolveTerms(graph, line, { sourceLanguage = "", targetLanguage = "", limit = 20 } = {}) {
  const text = String(line ?? "")
  if (!text.trim()) return []
  const targetSide = !sourceLanguage || !targetLanguage || sourceLanguage !== targetLanguage
  const terms = graph?.terms ?? []
  const byId = new Map(terms.map((term) => [term.id, term]))
  const hits = []
  for (const term of terms) {
    const best = bestMatch(term, text, targetSide)
    if (!best) continue
    const renderings = termRenderings(term)
    const rendered = best.kind === "source" || best.kind === "alias"
      ? renderings.accepted.some((rendering) => locateSurface(text, rendering).index >= 0)
      : true
    hits.push({
      id: term.id,
      source: term.source,
      target: term.target,
      partOfSpeech: term.partOfSpeech,
      translate: term.translate,
      side: matchRank[best.kind] <= matchRank.alias ? "source" : "target",
      kind: best.kind,
      rank: matchRank[best.kind],
      matched: best.matched,
      index: best.index,
      rendered,
      reason: matchReason(term, best.kind, best.matched),
      relations: termSummary(term, graph).relations,
    })
  }
  hits.sort((a, b) => a.rank - b.rank || a.index - b.index || b.matched.length - a.matched.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  // A longer surface swallows a shorter one at the same spot: "五条先生" is an alias of
  // "五条悟", so the line does not also apply the separate term "先生".
  const covered = hits.filter((hit) => hits.some((other) => other !== hit
    && other.index <= hit.index
    && other.index + other.matched.length >= hit.index + hit.matched.length
    && (other.index < hit.index || other.matched.length > hit.matched.length)))
  const distinct = hits.filter((hit) => !covered.includes(hit))
  const capped = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 20
  return distinct.slice(0, capped)
}

export function formatTerminologyGraph(graph) {
  const terms = graph?.terms ?? []
  const byId = new Map(terms.map((term) => [term.id, term]))
  const lines = []
  for (const term of terms) {
    lines.push(`${term.source} = ${term.target}`)
    for (const alias of term.aliases) lines.push(`@alias ${alias}`)
    for (const variant of term.variants) lines.push(`@variant ${variant}`)
    if (term.partOfSpeech !== defaultPartOfSpeech) lines.push(`@pos ${term.partOfSpeech}`)
    if (!term.translate) lines.push("@keep")
    for (const rendering of term.preferred.slice(1)) lines.push(`@prefer ${rendering}`)
    for (const rendering of term.forbidden) lines.push(`@forbid ${rendering}`)
    for (const type of relationTypes) {
      for (const id of term.relations[type]) {
        const other = byId.get(id)
        if (other) lines.push(`@${type} ${other.source}`)
      }
    }
  }
  return lines.join("\n")
}

// The plain projection: only the pairs a flat glossary can hold, plus the fields that had to
// be left behind, so a caller that must write legacy text never loses data silently.
export function flattenTerminologyGraph(graph) {
  const dropped = []
  const lines = []
  for (const term of graph?.terms ?? []) {
    lines.push(`${term.source} = ${term.target}`)
    const fields = []
    if (term.aliases.length) fields.push("aliases")
    if (term.variants.length) fields.push("variants")
    if (term.partOfSpeech !== defaultPartOfSpeech) fields.push("partOfSpeech")
    if (!term.translate) fields.push("translate")
    if (term.preferred.length > 1) fields.push("preferred")
    if (term.forbidden.length) fields.push("forbidden")
    if (relationTypes.some((type) => term.relations[type].length)) fields.push("relations")
    if (fields.length) dropped.push({ source: term.source, fields })
  }
  return { text: lines.join("\n"), dropped }
}

export function migrateGlossaryText(glossaryText) {
  return formatTerminologyGraph(parseTerminologyGraph(glossaryText))
}

function graphToRaw(graph) {
  const byId = new Map((graph?.terms ?? []).map((term) => [term.id, term]))
  return (graph?.terms ?? []).map((term) => ({
    source: term.source,
    target: term.target,
    aliases: [...term.aliases],
    variants: [...term.variants],
    preferred: term.preferred.filter((rendering) => keyOf(rendering) !== keyOf(term.target)),
    forbidden: [...term.forbidden],
    partOfSpeech: term.partOfSpeech,
    translate: term.translate,
    relations: Object.fromEntries(
      relationTypes.map((type) => [type, term.relations[type].map((id) => byId.get(id)?.source).filter(Boolean)]),
    ),
  }))
}

function entryTerms(entry) {
  if (typeof entry === "string") {
    // A text entry only speaks for the fields it actually spells out, so merging a plain
    // pair never resets a part of speech or a keep flag the graph already carries.
    return graphToRaw(parseTerminologyGraph(entry)).map((term) => ({
      ...term,
      partOfSpeech: /^@pos\b/im.test(entry) ? term.partOfSpeech : undefined,
      translate: /^@(keep|translate)\b/im.test(entry) ? term.translate : undefined,
    }))
  }
  if (!entry || typeof entry !== "object") return []
  const relations = Object.fromEntries(
    relationTypes.map((type) => {
      const declared = entry.relations?.[type]
      const flat = entry[type]
      return [
        type,
        [
          ...(Array.isArray(declared) ? declared : declared ? [declared] : []),
          ...(Array.isArray(flat) ? flat : flat ? [flat] : []),
        ],
      ]
    }),
  )
  return [{ ...entry, relations }]
}

// Merge follows the graph, not the raw text: an entry updates the term whose source - or
// alias - it names, whatever case or diacritics the model used, and relations may be
// declared from either end.
export function mergeTerminology(graph, entries) {
  const rawTerms = graphToRaw(graph)
  const bySource = new Map(rawTerms.map((term) => [keyOf(term.source), term]))
  const aliasOwner = (key) => rawTerms.find((term) => (term.aliases ?? []).some((alias) => keyOf(alias) === key))
  const added = []
  const updated = []
  const problems = []
  for (const entry of entries ?? []) {
    for (const raw of entryTerms(entry)) {
      const source = cleanText(raw.source)
      const key = keyOf(source)
      if (!key || !cleanText(raw.target)) {
        problems.push(problem(0, `Bỏ qua mục thuật ngữ thiếu nguồn hoặc thiếu bản dịch: "${source}".`))
        continue
      }
      const existing = bySource.get(key) ?? aliasOwner(key)
      if (existing) {
        mergeRawTerm(existing, { ...raw, source: existing.source })
        if (!updated.includes(existing.source)) updated.push(existing.source)
        continue
      }
      const term = {
        source,
        target: cleanText(raw.target),
        aliases: (raw.aliases ?? []).filter((alias) => !bySource.has(keyOf(alias)) && !aliasOwner(keyOf(alias))),
        variants: [...(raw.variants ?? [])],
        preferred: [...(raw.preferred ?? [])],
        forbidden: [...(raw.forbidden ?? [])],
        partOfSpeech: raw.partOfSpeech ?? defaultPartOfSpeech,
        translate: raw.translate !== false,
        relations: Object.fromEntries(relationTypes.map((type) => [type, [...(raw.relations?.[type] ?? [])]])),
      }
      rawTerms.push(term)
      bySource.set(key, term)
      added.push(source)
    }
  }
  const merged = buildGraph(rawTerms, problems)
  return { graph: merged, problems, added, updated }
}

// One line of feedback under the glossary field: how much the graph holds and the first thing
// that could not be read, so a typo in a directive never disappears silently.
export function glossaryStatusText(graph) {
  const terms = graph?.terms ?? []
  const links = terms.reduce(
    (total, term) => total + relationTypes.reduce((sum, type) => sum + (term.relations?.[type]?.length ?? 0), 0),
    0,
  )
  const base = terms.length ? `${terms.length} thuật ngữ · ${links} liên kết` : "Chưa có thuật ngữ nào"
  const problems = graph?.problems ?? []
  return problems.length ? `${base} · ${problems.length} dòng cần xem lại: ${problems[0].message}` : base
}
