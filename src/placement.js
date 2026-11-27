const minimumCoverage = 0.45
const minimumIoU = 0.08
const requiredLead = 0.05

export function readOcrBox(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length !== 4 ||
      !coordinates.every((value) => Number.isInteger(value) && value >= 0 && value <= 1000)) return null
  const [top, left, bottom, right] = coordinates
  return right > left && bottom > top ? [left, top, right, bottom] : null
}

// A box that a vision model reported, rather than a box this app computed.
//
// A model asked for integers still answers with decimals — the OpenAI-compatible route sends no
// response schema at all, and a schema on the Gemini route is only a hint — so every finite coordinate
// is rounded before the integer invariant, the 0-1000 range and the [top,left,bottom,right] ordering
// are checked. Normalizing the representation keeps a usable box instead of dropping every hit the
// model found; the shape is still enforced, so a non-numeric coordinate, a wrong length and an
// inverted rectangle all remain invalid.
export function readModelOcrBox(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length !== 4) return null
  const rounded = []
  for (let index = 0; index < 4; index++) {
    const value = coordinates[index]
    if (typeof value !== "number" || !Number.isFinite(value)) return null
    rounded.push(Math.round(value))
  }
  return readOcrBox(rounded)
}

export function toRectangle([left, top, right, bottom]) {
  return { x: left / 1000, y: top / 1000, w: (right - left) / 1000, h: (bottom - top) / 1000 }
}

export function toCoordinates({ x, y, w, h }) {
  return [x * 1000, y * 1000, (x + w) * 1000, (y + h) * 1000]
}

export function overlapScore(first, second) {
  const [left, top, right, bottom] = first
  const [otherLeft, otherTop, otherRight, otherBottom] = second
  const area = (right - left) * (bottom - top)
  const otherArea = (otherRight - otherLeft) * (otherBottom - otherTop)
  const overlapWidth = Math.min(right, otherRight) - Math.max(left, otherLeft)
  const overlapHeight = Math.min(bottom, otherBottom) - Math.max(top, otherTop)
  if (area <= 0 || otherArea <= 0 || overlapWidth <= 0 || overlapHeight <= 0) return 0
  const intersection = overlapWidth * overlapHeight
  const coverage = intersection / Math.min(area, otherArea)
  const iou = intersection / (area + otherArea - intersection)
  return coverage >= minimumCoverage && iou >= minimumIoU ? (coverage + iou) / 2 : 0
}

export function matchDialogue(lines, regions) {
  const highest = new Float64Array(regions.length)
  const runnerUp = new Float64Array(regions.length)
  const leaders = new Int32Array(regions.length).fill(-1)
  const choices = lines.map((line, lineIndex) => {
    let best = 0
    let second = 0
    let candidate = -1
    if (!line.box) return { candidate, best, second }
    regions.forEach((region, index) => {
      const score = overlapScore(line.box, region.box)
      if (score <= 0) return
      if (score > highest[index]) {
        runnerUp[index] = highest[index]
        highest[index] = score
        leaders[index] = lineIndex
      } else if (score > runnerUp[index]) {
        runnerUp[index] = score
      }
      if (score > best) {
        second = best
        best = score
        candidate = index
      } else if (score > second) {
        second = score
      }
    })
    return { candidate, best, second }
  })

  const placed = []
  const unplaced = []
  choices.forEach(({ candidate, best, second }, lineIndex) => {
    const line = lines[lineIndex]
    const competing = leaders[candidate] === lineIndex ? runnerUp[candidate] : highest[candidate]
    if (candidate === -1 || (second > 0 && best - second < requiredLead) ||
        (competing > 0 && competing >= best - requiredLead)) {
      unplaced.push(line)
    } else {
      placed.push({ line, region: regions[candidate] })
    }
  })
  return { placed, unplaced }
}
