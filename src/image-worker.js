import { inpaintRegion } from "./inpaint.js"
import { cleanRawPixels } from "./raw-cleanup.js"

self.addEventListener("message", (event) => {
  const { id, operation, width, height, options, rgba, mask } = event.data ?? {}
  try {
    if (operation === "clean_raw") {
      const result = cleanRawPixels(new Uint8ClampedArray(rgba), width, height, options)
      const buf = result.data.buffer
      self.postMessage(
        {
          id,
          ok: true,
          data: buf,
          meta: {
            blackPoint: result.blackPoint,
            whitePoint: result.whitePoint,
            grayscale: result.grayscale,
          },
        },
        [buf],
      )
      return
    }
    if (operation === "inpaint") {
      const pixels = new Uint8ClampedArray(rgba)
      const filled = inpaintRegion(pixels, width, height, new Uint8Array(mask))
      const buf = pixels.buffer
      self.postMessage({ id, ok: true, filled, data: buf }, [buf])
      return
    }
    throw new Error("Unknown image worker operation.")
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || "Image worker error." })
  }
})
