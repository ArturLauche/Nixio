import assert from "node:assert/strict"
import test from "node:test"
import {
  findTerm,
  flattenTerminologyGraph,
  formatTerminologyGraph,
  glossaryStatusText,
  mergeTerminology,
  migrateGlossaryText,
  parseTerminologyGraph,
  resolveTerms,
  termRenderings,
  termSummary,
} from "../src/terminology-graph.js"
import { lintChapter, parseGlossary } from "../src/linter.js"
import { createAgentTools } from "../src/agent-tools.js"

const graphTerm = (graph, ref) => termSummary(findTerm(graph, ref), graph)

test("flat glossary text reads as terms, keeps file order and formats back unchanged", () => {
  const legacy = ["# Nhân vật", "五条悟 = Gojo Satoru", "領域展開 -> Lãnh Địa Triển Khai", "Sensei : Sư phụ"].join("\n")
  const graph = parseTerminologyGraph(legacy)

  assert.deepEqual(graph.problems, [])
  assert.deepEqual(
    graph.terms.map(({ source, target }) => [source, target]),
    [["五条悟", "Gojo Satoru"], ["領域展開", "Lãnh Địa Triển Khai"], ["Sensei", "Sư phụ"]],
  )
  assert.deepEqual(parseGlossary(legacy), graph.terms.map(({ source, target }) => ({ source, target })))

  // A legacy glossary never gains directives it did not carry: one separator is canonical.
  assert.equal(migrateGlossaryText(legacy), "五条悟 = Gojo Satoru\n領域展開 = Lãnh Địa Triển Khai\nSensei = Sư phụ")
  assert.equal(formatTerminologyGraph(graph), migrateGlossaryText(legacy))
  for (const term of graph.terms) {
    assert.equal(term.partOfSpeech, "term")
    assert.equal(term.translate, true)
    assert.deepEqual(term.aliases, [])
    assert.deepEqual(term.preferred, [term.target])
    assert.deepEqual(term.relations, { broader: [], narrower: [], related: [], conflict: [] })
  }
})

test("directives carry aliases, variants, part of speech, keep flag and renderings losslessly", () => {
  const text = [
    "五条悟 = Gojo Satoru",
    "@alias 五条先生",
    "@variant Gojou Satoru",
    "@pos name",
    "@prefer Ngũ Điều Ngộ",
    "@forbid Gojo Saturo",
    "先生 = Thầy",
    "@pos honorific",
    "@keep",
  ].join("\n")
  const graph = parseTerminologyGraph(text)
  const gojo = graphTerm(graph, "五条悟")
  assert.deepEqual(gojo.aliases, ["五条先生"])
  assert.deepEqual(gojo.variants, ["Gojou Satoru"])
  assert.equal(gojo.partOfSpeech, "name")
  assert.deepEqual(gojo.preferred, ["Gojo Satoru", "Ngũ Điều Ngộ"])
  assert.deepEqual(gojo.forbidden, ["Gojo Saturo"])
  assert.equal(graphTerm(graph, "先生").translate, false)

  const renderings = termRenderings(findTerm(graph, "五条悟"))
  assert.deepEqual(renderings.accepted, ["Gojo Satoru", "Ngũ Điều Ngộ", "Gojou Satoru"])
  assert.equal(renderings.translationRequired, true)
  // "keep" means the source form itself is the rendering, and nothing has to be translated.
  const kept = termRenderings(findTerm(graph, "先生"))
  assert.deepEqual(kept.accepted, ["Thầy", "先生"])
  assert.equal(kept.translationRequired, false)

  assert.equal(formatTerminologyGraph(parseTerminologyGraph(formatTerminologyGraph(graph))), formatTerminologyGraph(graph))

  // The flat projection reports every field it cannot express instead of dropping it silently.
  const flat = flattenTerminologyGraph(graph)
  assert.equal(flat.text, "五条悟 = Gojo Satoru\n先生 = Thầy")
  assert.deepEqual(flat.dropped, [
    { source: "五条悟", fields: ["aliases", "variants", "partOfSpeech", "preferred", "forbidden"] },
    { source: "先生", fields: ["partOfSpeech", "translate"] },
  ])
  assert.equal(parseTerminologyGraph(text).terms.length, parseTerminologyGraph(flat.text).terms.length)
})

test("broader/narrower, related and conflict stay consistent from either endpoint", () => {
  const graph = parseTerminologyGraph([
    "領域展開 = Lãnh Địa Triển Khai",
    "@narrower 無下限",
    "無下限 = Vô Hạn",
    "先生 = Thầy",
    "@conflict 悟君",
    "悟君 = Gojo-kun",
    "呪術師 = Chú Thuật Sư",
    "@related 六眼",
    "六眼 = Lục Nhãn",
  ].join("\n"))
  const domain = findTerm(graph, "領域展開")
  const limitless = findTerm(graph, "無下限")
  const teacher = findTerm(graph, "先生")
  const boy = findTerm(graph, "悟君")
  const sorcerer = findTerm(graph, "呪術師")
  const eyes = findTerm(graph, "六眼")

  assert.deepEqual(domain.relations.narrower, [limitless.id])
  assert.deepEqual(limitless.relations.broader, [domain.id])
  assert.deepEqual(teacher.relations.conflict, [boy.id])
  assert.deepEqual(boy.relations.conflict, [teacher.id])
  assert.deepEqual(sorcerer.relations.related, [eyes.id])
  assert.deepEqual(eyes.relations.related, [sorcerer.id])

  // Declaring the inverse on the other side lands on the same edges.
  const mirrored = parseTerminologyGraph("領域展開 = Lãnh Địa Triển Khai\n無下限 = Vô Hạn\n@broader 領域展開")
  assert.deepEqual(findTerm(mirrored, "領域展開").relations.narrower, [findTerm(mirrored, "無下限").id])

  const unknown = parseTerminologyGraph("A = B\n@broader A\n@related Không Có")
  assert.deepEqual(unknown.terms[0].relations.broader, [])
  assert.equal(unknown.problems.length, 1)
  assert.match(unknown.problems[0].message, /Không tìm thấy thuật ngữ "Không Có"/)
  assert.match(glossaryStatusText(unknown), /1 thuật ngữ · 0 liên kết · 1 dòng cần xem lại/)
})

test("the resolver answers a line with the same terms in the same order whatever the file order", () => {
  const blocks = [
    "五条悟 = Gojo Satoru\n@alias 五条先生\n@forbid Gojo Saturo",
    "先生 = Thầy\n@variant Thầy giáo",
    "領域展開 = Lãnh Địa Triển Khai",
  ]
  const graph = parseTerminologyGraph(blocks.join("\n"))
  const options = { sourceLanguage: "Japanese", targetLanguage: "Vietnamese" }
  const line = "五条先生 tung Lãnh Địa Triển Khai"
  const hits = resolveTerms(graph, line, options)

  assert.deepEqual(hits.map(({ kind, side, matched, rendered }) => [kind, side, matched, rendered]), [
    // The line carries the Japanese alias but no Vietnamese rendering of the name yet.
    ["alias", "source", "五条先生", false],
    ["preferred", "target", "Lãnh Địa Triển Khai", true],
  ])
  assert.match(hits[0].reason, /^Khớp biến thể nguồn "五条先生" của "五条悟" → dịch thành "Gojo Satoru"\.$/)
  assert.match(hits[1].reason, /^Đã dùng đúng bản dịch ưu tiên "Lãnh Địa Triển Khai"\.$/)

  // A reordered glossary produces byte-identical results, so the order is a property of the line.
  assert.deepEqual(resolveTerms(parseTerminologyGraph(blocks.slice().reverse().join("\n")), line, options), hits)

  // Rank first (source before rendering), then the position in the line.
  const ordered = resolveTerms(graph, "Gojo Satoru 領域展開", options)
  assert.deepEqual(ordered.map(({ kind, source }) => [kind, source]), [
    ["source", "領域展開"],
    ["preferred", "五条悟"],
  ])
  // Forbidden renderings are reported as such, and a missing rendering is visible.
  const banned = resolveTerms(graph, "Gojo Saturo cười", options)
  assert.deepEqual(banned.map(({ kind, matched }) => [kind, matched]), [["forbidden", "Gojo Saturo"]])
  assert.match(banned[0].reason, /^"Gojo Saturo" là dạng bị cấm; phải dùng "Gojo Satoru"\.$/)
  const variant = resolveTerms(graph, "Thầy giáo gọi", options)
  assert.deepEqual(variant.map(({ kind, matched }) => [kind, matched]), [["variant", "Thầy giáo"]])
  assert.match(variant[0].reason, /chuẩn hoá về "Thầy"\.$/)
  assert.equal(resolveTerms(graph, "五条悟 xuất hiện", options)[0].rendered, false)
  // A variant still points at its term, which is how "biến thể chuẩn hoá về term chính" reads.
  assert.equal(findTerm(graph, "thay giao")?.source, "先生")
  assert.equal(findTerm(graph, "gojo saturo")?.source, "五条悟")
  // A longer alias swallows the shorter term it contains.
  assert.deepEqual(resolveTerms(graph, "五条先生 tung Lãnh Địa Triển Khai", options).map(({ source }) => source), ["五条悟", "領域展開"])

  // Same source and target language means there is no target side to match.
  assert.deepEqual(resolveTerms(graph, "Gojo Satoru", { sourceLanguage: "English", targetLanguage: "English" }), [])
  assert.equal(resolveTerms(graph, "Gojo Satoru", options)[0].kind, "preferred")
  assert.deepEqual(resolveTerms(graph, "   ", options), [])
  assert.equal(resolveTerms(graph, line, { ...options, limit: 1 }).length, 1)
})

test("chapter QA walks the graph: aliases, variants, forbidden forms, keep flag, part of speech and relations", () => {
  const lint = (text, glossaryText) => lintChapter(
    [{ id: "p1", name: "01.png", boxes: [{ id: "b1", text }] }],
    { glossaryText, sourceLanguage: "Japanese", targetLanguage: "Vietnamese" },
  )
  const violations = (text, glossaryText) => lint(text, glossaryText).byType.glossary_violation

  // (a) An alias is the same term, so it still has to be translated; a listed rendering is enough.
  const alias = "五条悟 = Gojo Satoru\n@alias 五条先生"
  assert.equal(violations("五条先生 đứng đó", alias), 1)
  assert.equal(violations("五条先生 và Gojo Satoru đứng đó", alias), 0)

  // A variant normalises to the main term instead of counting as drift.
  const variant = "先生 = Thầy\n@variant Thầy giáo"
  assert.equal(violations("Tôi gặp Thầy giáo.", variant), 0)
  assert.equal(violations("Tôi gặp Thầy.", variant), 0)

  // (b) A forbidden rendering is always reported, with the preferred one as the suggestion.
  const forbidden = lint("Gojo Saturo xuất hiện", "五条悟 = Gojo Satoru\n@forbid Gojo Saturo")
  assert.equal(forbidden.byType.glossary_violation, 1)
  assert.match(forbidden.issues[0].message, /^"Gojo Saturo" là dạng bị cấm của "五条悟"; phải dùng "Gojo Satoru"\.$/)
  assert.equal(forbidden.issues[0].suggestion, "Gojo Satoru")

  // (c) Conflict relations are the kính ngữ check: one line cannot mix both address forms.
  const honorific = "先生 = Thầy\n@pos honorific\n@conflict 悟君\n悟君 = Gojo-kun"
  const mixed = lint("Thầy và Gojo-kun cùng cười", honorific)
  assert.equal(mixed.byType.glossary_violation, 1)
  assert.match(mixed.issues[0].message, /^Xung đột xưng hô: "Thầy" và "Gojo-kun" không dùng cùng một câu\.$/)
  assert.equal(violations("Thầy đi rồi", honorific), 0)
  assert.equal(violations("Gojo-kun đi rồi", honorific), 0)

  // The keep flag means the name is carried over verbatim, so it never demands a translation.
  assert.equal(violations("先生 đi rồi", "先生 = Thầy\n@keep"), 0)
  assert.equal(violations("先生 đi rồi", "先生 = Thầy"), 1)

  // A declared name keeps the casing check that a plain term only gets when multi-word.
  assert.equal(violations("Tôi gặp thầy.", "先生 = Thầy\n@pos name"), 1)
  assert.equal(violations("Tôi gặp thầy.", "先生 = Thầy"), 0)

  // The report keeps its four buckets, so existing consumers keep reading the same shape.
  assert.deepEqual(Object.keys(lint("Thầy và Gojo-kun", honorific).byType), [
    "untranslated_source",
    "glossary_violation",
    "empty_or_placeholder",
    "punctuation_spacing",
  ])
})

test("merging follows the graph, so an alias, a case difference or a declared relation lands on the same term", () => {
  const graph = parseTerminologyGraph("先生 = Thầy\n@pos honorific")
  const merged = mergeTerminology(graph, [
    "五条悟 = Gojo Satoru\n@alias 五条先生",
    { source: "五条先生", target: "Satoru Gojo", forbidden: ["Gojo Saturo"], related: ["先生"] },
  ])
  assert.deepEqual(merged.added, ["五条悟"])
  assert.deepEqual(merged.updated, ["五条悟"])
  assert.equal(merged.graph.terms.length, 2)
  const gojo = findTerm(merged.graph, "五条悟")
  assert.equal(gojo.target, "Satoru Gojo")
  assert.deepEqual(gojo.forbidden, ["Gojo Saturo"])
  assert.deepEqual(gojo.aliases, ["五条先生"])
  assert.deepEqual(gojo.relations.related, [findTerm(merged.graph, "先生").id])

  // A plain pair updates the rendering without resetting the directives already stored.
  const plain = mergeTerminology(merged.graph, ["五条悟 = Gojo Satoru"]).graph
  assert.equal(findTerm(plain, "五条悟").target, "Gojo Satoru")
  assert.deepEqual(findTerm(plain, "五条悟").aliases, ["五条先生"])
  assert.equal(findTerm(plain, "先生").partOfSpeech, "honorific")

  // Case and diacritics do not create a second entry.
  const folded = mergeTerminology(parseTerminologyGraph("Đi thôi = Đi thôi"), ["di thoi = Bước đi"])
  assert.equal(folded.graph.terms.length, 1)
  assert.deepEqual(folded.updated, ["Đi thôi"])
})

test("update_glossary stores the graph and query_terminology reads it back with reasons", async () => {
  const field = { value: "先生 = Thầy", dispatchEvent() {} }
  const state = { pages: [], queue: [], presets: [] }
  const tools = createAgentTools({
    state,
    byId: (id) => (id === "translation-glossary" ? field : null),
    selectedPage: () => null,
    selectedIndex: () => -1,
    selectPage() {},
    checkpoint() {},
    render() {},
    readTranslationSettings: () => ({ source: "Japanese", target: "Vietnamese", direction: "rtl", notes: "", glossary: field.value }),
  })

  const added = await tools.execute("update_glossary", {
    entries: [{
      source: "五条悟",
      target: "Gojo Satoru",
      aliases: ["五条先生"],
      partOfSpeech: "name",
      forbidden: ["Gojo Saturo"],
      relations: { conflict: ["先生"] },
    }],
  }, { allowEdits: true })
  assert.equal(added.ok, true)
  // The relation is written from both ends of the conflict, which is what keeps it symmetric.
  assert.equal(
    field.value,
    "先生 = Thầy\n@conflict 五条悟\n五条悟 = Gojo Satoru\n@alias 五条先生\n@pos name\n@forbid Gojo Saturo\n@conflict 先生",
  )
  assert.equal(added.data.totalEntries, 2)
  // The runtime snapshot counts terms, so directives never inflate the glossary size.
  assert.equal(tools.getRuntimeSnapshot().glossaryCount, 2)

  const detail = await tools.execute("query_terminology", { term: "gojo saturo" })
  assert.equal(detail.ok, true)
  assert.equal(detail.data.term.source, "五条悟")
  assert.deepEqual(detail.data.term.forbidden, ["Gojo Saturo"])
  assert.deepEqual(detail.data.term.relations.conflict, ["先生"])

  const matched = await tools.execute("query_terminology", { text: "五条先生 nhìn Gojo Saturo" })
  assert.equal(matched.ok, true)
  assert.equal(matched.data.matched[0].kind, "alias")
  assert.match(matched.data.matched[0].reason, /dịch thành "Gojo Satoru"/)

  const status = await tools.execute("query_terminology", {})
  assert.match(status.summary, /^2 thuật ngữ · 2 liên kết$/)
  assert.equal(status.data.terms.length, 2)

  const replaced = await tools.execute("update_glossary", { entries: ["A = B"], mode: "replace" }, { allowEdits: true })
  assert.equal(replaced.ok, true)
  assert.equal(field.value, "A = B")

  const empty = await tools.execute("update_glossary", { entries: [] }, { allowEdits: true })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /Danh sách thuật ngữ rỗng/)
})
