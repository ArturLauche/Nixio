import { encodePng } from "./png.mjs"

export const BASELINE_APPROVAL_ENV = "VISUAL_BASELINE_APPROVAL"

export function updateRefusal({ update, env = process.env } = {}) {
  if (!update) return null
  if (env.CI) {
    return "Refusing to rewrite visual baselines in CI. Baselines are updated by an operator on the canonical environment and reviewed as committed PNG diffs."
  }
  if (env[BASELINE_APPROVAL_ENV] !== "1") {
    return `Refusing to rewrite visual baselines. Review the screenshot difference, then re-run with ${BASELINE_APPROVAL_ENV}=1 (npm run test:visual:update) and commit the reviewed PNG diffs.`
  }
  return null
}

export function resolvePlatform(config, platform = process.platform) {
  const settings = config.platforms?.[platform]
  if (!settings) return { supported: false, platform }
  return {
    supported: true,
    platform,
    channelThreshold: settings.channelThreshold ?? 0,
    maxDiffPixels: settings.maxDiffPixels ?? 0,
    maxDiffPixelRatio: settings.maxDiffPixelRatio ?? 0,
  }
}

export function allowedDiffPixels(tolerance, totalPixels) {
  return Math.max(tolerance.maxDiffPixels ?? 0, Math.ceil((tolerance.maxDiffPixelRatio ?? 0) * totalPixels))
}

export function compareImages(baseline, actual, tolerance) {
  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return {
      pass: false,
      reason: `dimensions differ: ${baseline.width}x${baseline.height} baseline vs ${actual.width}x${actual.height} actual`,
      width: baseline.width,
      height: baseline.height,
      totalPixels: baseline.width * baseline.height,
      diffPixels: baseline.width * baseline.height,
      ratio: 1,
    }
  }
  const threshold = tolerance.channelThreshold ?? 0
  const totalPixels = baseline.width * baseline.height
  let diffPixels = 0
  for (let pixel = 0; pixel < totalPixels; pixel++) {
    const at = pixel * 4
    if (
      Math.abs(baseline.data[at] - actual.data[at]) > threshold ||
      Math.abs(baseline.data[at + 1] - actual.data[at + 1]) > threshold ||
      Math.abs(baseline.data[at + 2] - actual.data[at + 2]) > threshold ||
      Math.abs(baseline.data[at + 3] - actual.data[at + 3]) > threshold
    ) diffPixels++
  }
  const ratio = diffPixels / totalPixels
  const allowed = allowedDiffPixels(tolerance, totalPixels)
  return {
    pass: diffPixels <= allowed,
    reason: diffPixels <= allowed ? null : `${diffPixels} pixels differ beyond ±${threshold} levels; ${allowed} allowed`,
    width: baseline.width,
    height: baseline.height,
    totalPixels,
    diffPixels,
    ratio,
    allowedDiffPixels: allowed,
    channelThreshold: threshold,
  }
}

export function createDiffImage(baseline, actual, tolerance) {
  const { width, height } = baseline
  const threshold = tolerance.channelThreshold ?? 0
  const data = Buffer.alloc(width * height * 4)
  for (let pixel = 0; pixel < width * height; pixel++) {
    const at = pixel * 4
    const changed =
      Math.abs(baseline.data[at] - actual.data[at]) > threshold ||
      Math.abs(baseline.data[at + 1] - actual.data[at + 1]) > threshold ||
      Math.abs(baseline.data[at + 2] - actual.data[at + 2]) > threshold ||
      Math.abs(baseline.data[at + 3] - actual.data[at + 3]) > threshold
    if (changed) data.set([255, 0, 170, 255], at)
    else {
      const grey = Math.round((actual.data[at] * 54 + actual.data[at + 1] * 183 + actual.data[at + 2] * 19) / 256)
      const faded = 235 - Math.round((255 - grey) * .25)
      data.set([faded, faded, faded, 255], at)
    }
  }
  return encodePng({ width, height, data })
}
