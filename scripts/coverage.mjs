import { mkdir, readFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  CONTROLLER_LINE_FLOOR,
  checkControllerCoverage,
  formatReport,
  listControllerFiles,
} from "./check-controller-coverage.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const outputDirectory = path.join(root, "artifacts", "coverage")
const lcovFile = path.join(outputDirectory, "lcov.info")

await mkdir(outputDirectory, { recursive: true })
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    `--test-reporter-destination=${lcovFile}`,
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit" },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const gate = checkControllerCoverage({
  lcov: await readFile(lcovFile, "utf8"),
  controllerFiles: await listControllerFiles(),
})
console.log(`\nController coverage (${path.relative(root, lcovFile)}):`)
console.log(formatReport({ summary: gate.summary, floor: CONTROLLER_LINE_FLOOR }))
for (const failure of gate.failures) console.error(`\nCoverage gate failed: ${failure}`)
if (!gate.ok) process.exitCode = 1
