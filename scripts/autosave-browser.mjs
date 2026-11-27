// Real-browser check for src/web-storage.js: two tabs of the same origin share
// one IndexedDB, so this is the only place where cross-tab writes, a blocked
// upgrade and the legacy `latest` record can be reproduced honestly.
//
// Run with `npm run test:autosave` (needs the Playwright Chromium download).

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const root = fileURLToPath(new URL("..", import.meta.url))
const pagePath = "/test/browser/web-storage.html"
const projectA = "11111111-2222-3333-4444-555555555555"
const projectB = "99999999-8888-7777-6666-555555555555"
const projectC = "33333333-4444-5555-6666-777777777777"

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1")
    if (url.pathname === "/") {
      response.writeHead(302, { location: pagePath })
      response.end()
      return
    }
    // The harness page has no icon; answering avoids a console 404 that would
    // look like a page error.
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204)
      response.end()
      return
    }
    const target = path.resolve(root, "." + decodeURIComponent(url.pathname))
    const relative = path.relative(root, target)
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      response.writeHead(404)
      response.end()
      return
    }
    const body = await readFile(target)
    response.writeHead(200, {
      "content-type": contentTypes[path.extname(target)] ?? "application/octet-stream",
      "cache-control": "no-store",
    })
    response.end(body)
  } catch {
    response.writeHead(404)
    response.end()
  }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ headless: true })
const failures = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function openTab(context) {
  const page = await context.newPage()
  page.errors = []
  page.on("pageerror", (error) => page.errors.push(error))
  page.on("console", (message) => {
    if (message.type() === "error") page.errors.push(new Error(message.text()))
  })
  await page.goto(base + pagePath)
  await page.waitForFunction(() => window.harnessReady === true)
  return page
}

async function scenario(name, run) {
  const context = await browser.newContext()
  try {
    await run(context)
    console.log(`ok   ${name}`)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
    console.error(`FAIL ${name}\n     ${error.message}`)
  } finally {
    await context.close()
  }
}

const call = (page, method, argument) => page.evaluate(
  ([name, value]) => window.harness[name](value),
  [method, argument],
)

try {
  await scenario("two tabs keep distinct projects separately recoverable", async (context) => {
    const first = await openTab(context)
    const second = await openTab(context)
    assert.equal((await call(first, "save", { projectId: projectA, pageCount: 2, payload: "tab-1" })).ok, true)
    assert.equal((await call(second, "save", { projectId: projectB, payload: "tab-2" })).ok, true)

    const snapshots = await call(first, "list")
    assert.equal(snapshots.length, 2)
    assert.deepEqual(snapshots.map((item) => item.projectId).sort(), [projectA, projectB].sort())

    const recordA = snapshots.find((item) => item.projectId === projectA)
    const loaded = await call(first, "loadText", recordA.id)
    assert.equal(loaded.projectId, projectA)
    assert.equal(loaded.recovery, true)
    assert.ok(loaded.body.endsWith("tab-1"), "the payload of project A is untouched")
    assert.equal(recordA.pageCount, 2)

    const otherView = await call(second, "list")
    assert.equal(otherView.find((item) => item.projectId === projectA).mine, false)
    assert.equal(otherView.find((item) => item.projectId === projectB).mine, true)
    assert.deepEqual([...first.errors, ...second.errors], [])
  })

  await scenario("two tabs on the same project keep both snapshots", async (context) => {
    const first = await openTab(context)
    const second = await openTab(context)
    assert.equal((await call(first, "save", { projectId: projectA, revision: 5, pageCount: 2, payload: "rev-5" })).ok, true)
    await sleep(20)
    assert.equal((await call(second, "save", { projectId: projectA, revision: 2, payload: "rev-2" })).ok, true)

    const snapshots = await call(first, "list")
    assert.equal(snapshots.length, 2, "the first tab snapshot must not be overwritten")
    assert.deepEqual(snapshots.map((item) => item.revision), [2, 5])
    const bodies = await Promise.all(snapshots.map((item) => call(first, "loadText", item.id)))
    assert.deepEqual(bodies.map((item) => item.body.slice(-5)).sort(), ["rev-2", "rev-5"])
    assert.equal(snapshots[0].mine, false)
    assert.equal(snapshots[1].mine, true)
    assert.deepEqual([...first.errors, ...second.errors], [])
  })

  await scenario("one tab's repeated saves replace only its own slot", async (context) => {
    const first = await openTab(context)
    const second = await openTab(context)
    assert.equal((await call(first, "save", { projectId: projectA, revision: 1, payload: "first" })).ok, true)
    for (let index = 0; index < 6; index += 1) {
      assert.equal((await call(second, "save", { projectId: projectB, revision: index + 1, payload: `second-${index}` })).ok, true)
    }

    const snapshots = await call(first, "list")
    assert.equal(snapshots.length, 2, "each page instance keeps exactly one slot")
    const projectAView = snapshots.find((item) => item.projectId === projectA)
    const projectBView = snapshots.find((item) => item.projectId === projectB)
    assert.ok(projectAView && projectBView)
    assert.equal(projectBView.revision, 6)
    assert.ok((await call(first, "loadText", projectAView.id)).body.endsWith("first"), "the slow tab keeps its snapshot")
    assert.ok((await call(first, "loadText", projectBView.id)).body.endsWith("second-5"))
    assert.deepEqual([...first.errors, ...second.errors], [])
  })

  await scenario("the legacy latest record and stored fonts survive the migration", async (context) => {
    const first = await openTab(context)
    const seeded = await call(first, "seedLegacy", { projectId: projectC, pageCount: 3 })
    assert.ok(seeded.size > 0)

    const snapshots = await call(first, "list")
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0].projectId, projectC)
    assert.equal(snapshots[0].pageCount, 3)
    assert.equal(snapshots[0].legacy, true)
    assert.equal(snapshots[0].savedAt, 1700000000000)
    assert.equal(await call(first, "hasLegacyKey"), false, "the old fixed key is gone")

    const loaded = await call(first, "loadText", snapshots[0].id)
    assert.equal(loaded.projectId, projectC)
    assert.ok(loaded.body.endsWith("legacy"))
    assert.deepEqual(await call(first, "listFonts"), [{ family: "Font Cũ", size: 4 }])

    // A second tab reads the migrated record from the database, not from memory.
    const second = await openTab(context)
    const persisted = await call(second, "list")
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].id, snapshots[0].id)
    assert.deepEqual(await call(second, "listFonts"), [{ family: "Font Cũ", size: 4 }])
    assert.deepEqual([...first.errors, ...second.errors], [])
  })

  await scenario("a blocked upgrade is reported and recovers when the old tab closes", async (context) => {
    const oldTab = await openTab(context)
    assert.equal(await call(oldTab, "holdOldConnection"), 1)

    const tab = await openTab(context)
    const blocked = await call(tab, "save", { projectId: projectA, payload: "blocked" })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.reason, "blocked")
    assert.deepEqual(await call(tab, "state"), { supported: true, blocked: true })

    await oldTab.evaluate(() => window.harness.closeOldConnection())
    await sleep(200)
    const recovered = await call(tab, "save", { projectId: projectA, payload: "after-unblock" })
    assert.equal(recovered.ok, true, "the retry after the old connection closed must succeed")
    assert.equal((await call(tab, "list")).length, 1)
    assert.deepEqual(await call(tab, "state"), { supported: true, blocked: false })
    assert.deepEqual([...oldTab.errors, ...tab.errors], [])
  })
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}

if (failures.length) {
  console.error(`\n${failures.length} autosave browser check(s) failed:\n- ${failures.join("\n- ")}`)
  process.exitCode = 1
} else {
  console.log("\nAll autosave browser checks passed.")
}
