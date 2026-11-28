import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const ridByPlatform = { linux: "linux", win32: "win", darwin: "osx" }
const rid = (ridByPlatform[process.platform] ?? process.platform) + "-" + process.arch

export const executable = path.join(
  root,
  "native",
  "out",
  rid,
  "native-worker",
  "KhungThoai.Redraw" + (process.platform === "win32" ? ".exe" : ""),
)

export function nativeRequired(env = process.env) {
  return /^(1|true|yes)$/i.test(env.REQUIRE_NATIVE ?? "")
}

export function missingWorkerMessage(file) {
  return (
    `Native worker is required (REQUIRE_NATIVE=1) but missing at ${file}. ` +
    "Run `npm run desktop:native` before the tests, or leave REQUIRE_NATIVE unset to skip native coverage."
  )
}

export function nativeWorker({ env = process.env, file = executable } = {}) {
  const available = existsSync(file)
  if (!available && nativeRequired(env)) throw new Error(missingWorkerMessage(file))
  return { executable: file, available }
}

export function nativeSkip(t, reason, env = process.env) {
  if (nativeRequired(env)) throw new Error(`${reason}, and REQUIRE_NATIVE=1 forbids skipping native tests.`)
  return t.skip(reason)
}
