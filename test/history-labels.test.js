import assert from "node:assert/strict"
import test from "node:test"
import { readFile, readdir } from "node:fs/promises"

const main = await readFile(new URL("../src/main.js", import.meta.url), "utf8")
const controllerDir = new URL("../src/controllers/", import.meta.url)
const controllerFiles = (await readdir(controllerDir)).filter((name) => name.endsWith(".js"))
const controllers = Object.fromEntries(await Promise.all(controllerFiles.map(async (name) => [
  `src/controllers/${name}`,
  await readFile(new URL(name, controllerDir), "utf8"),
])))
const sources = { "src/main.js": main, ...controllers }

// Every checkpoint records one action, so the argument list of each call site is what the timeline
// will show. Extracting the balanced parentheses keeps a multi-line meta object in one piece.
function checkpointCalls(source) {
  const calls = []
  const marker = /\bcheckpoint\(/g
  let match
  while ((match = marker.exec(source))) {
    const start = match.index
    if (/function\s+$/.test(source.slice(Math.max(0, start - 12), start))) continue
    const open = start + match[0].length - 1
    let depth = 0
    let index = open
    for (; index < source.length; index++) {
      if (source[index] === "(") depth++
      else if (source[index] === ")" && --depth === 0) break
    }
    calls.push({
      args: source.slice(open + 1, index),
      line: source.slice(0, start).split("\n").length,
    })
    marker.lastIndex = index + 1
  }
  return calls
}

// Shared meta objects keep a name in one place; their kind still has to reach the timeline chip.
function metaKinds(source) {
  const kinds = new Map()
  for (const [, name, body] of source.matchAll(/const (\w+_META) = \{([^}]*)\}/g)) {
    const kind = body.match(/kind:\s*"([^"]+)"/)?.[1]
    if (kind) kinds.set(name, kind)
  }
  return kinds
}

test("every checkpoint in the shipped editor names its action", () => {
  const unnamed = []
  for (const [file, source] of Object.entries(sources)) {
    for (const { args, line } of checkpointCalls(source)) {
      const named = /label\s*:/.test(args) || /\w+_META\b/.test(args)
      if (!named) unnamed.push(`${file}:${line} checkpoint(${args.trim()})`)
    }
  }
  assert.deepEqual(unnamed, [], "a bare checkpoint() records the generic fallback label")
})

test("every meta object a checkpoint passes is defined in the same module", () => {
  for (const [file, source] of Object.entries(sources)) {
    const defined = metaKinds(source)
    for (const { args } of checkpointCalls(source)) {
      for (const [, name] of args.matchAll(/\b(\w+_META)\b/g)) {
        assert.ok(defined.has(name), `${file} passes ${name} without defining it`)
        assert.ok(/label:\s*"/.test(source.match(new RegExp(`const ${name} = \\{([^}]*)\\}`))?.[1] ?? ""),
          `${name} in ${file} must carry a label`)
      }
    }
  }
})

test("every kind a checkpoint records has a timeline chip", () => {
  const chipBlock = main.match(/const historyKindLabels = \{([\s\S]*?)\n\}/)?.[1] ?? ""
  const chips = new Set([...chipBlock.matchAll(/(?:"([\w-]+)"|(\w[\w-]*)):\s*"/g)]
    .map(([, quoted, bare]) => quoted ?? bare))
  assert.ok(chips.size >= 10, "the chip map must still list the recorded kinds")

  const recorded = new Set()
  for (const [file, source] of Object.entries(sources)) {
    const shared = metaKinds(source)
    for (const { args } of checkpointCalls(source)) {
      for (const [, kind] of args.matchAll(/kind:\s*"([\w-]+)"/g)) recorded.add(kind)
      for (const [, name] of args.matchAll(/\b(\w+_META)\b/g)) {
        const kind = shared.get(name)
        if (kind) recorded.add(kind)
      }
    }
  }
  assert.ok(recorded.size >= 10, "the shipped call sites must cover the recorded kinds")
  assert.deepEqual([...recorded].filter((kind) => !chips.has(kind)), [])
  assert.deepEqual([...chips].filter((kind) => !recorded.has(kind)), [])
})

test("the labels that reach the timeline stay specific instead of repeating the fallback", () => {
  const labels = new Set()
  for (const source of Object.values(sources)) {
    for (const { args } of checkpointCalls(source)) {
      for (const [, label] of args.matchAll(/label:\s*(?:"([^"]*)"|`([^`$]*)`)/g)) {
        const text = (label ?? "").trim()
        if (text) labels.add(text)
      }
    }
    for (const [, body] of source.matchAll(/const \w+_META = \{([^}]*)\}/g)) {
      const label = body.match(/label:\s*"([^"]+)"/)?.[1]
      if (label) labels.add(label)
    }
  }
  // Static labels alone cannot carry the inventory; the dynamic call sites name the page, the
  // count or the query inline, so a healthy map has a dozen distinct names before those.
  assert.ok(labels.size >= 12, `expected at least 12 distinct action names, saw ${[...labels].sort().join(" | ")}`)
  for (const label of labels) {
    assert.ok(label.length <= 60, `action name too long for the timeline: ${label}`)
    assert.equal(label, label.trim())
  }
})
