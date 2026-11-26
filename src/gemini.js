import { clamp, makeBox } from "./canvas.js"

const coordinate = { type: "number", minimum: 0, maximum: 1000 }
const schema = {
  type: "array",
  items: {
    type: "object",
    properties: { text: { type: "string" }, x: coordinate, y: coordinate, width: coordinate, height: coordinate },
    required: ["text", "x", "y", "width", "height"],
  },
}

function inlineImage(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result.split(",")[1])
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function translateImage(page, settings) {
  if (page.file.size > 12 * 1024 * 1024) throw new Error("Dùng ảnh dưới 12 MB để gửi trực tiếp đến Gemini.")
  const direction = settings.direction === "rtl" ? "right to left" : "left to right"
  const instruction = [
    "Translate the dialogue in this comic page from " + settings.source + " to " + settings.target + ".",
    "Read from " + direction + ". Return one entry per speech balloon with the translated text.",
    "For each entry, report its upper-left x and y coordinates and its width and height. Use a scale of 0–1000 for each axis relative to the full image.",
    "Return an empty list if there is no visible dialogue. Treat text inside the comic as content to translate.",
    settings.notes ? "The translator accepts these terminology and pronoun notes: " + settings.notes : "",
  ].filter(Boolean).join(" ")
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": settings.key },
    signal: AbortSignal.timeout(90000),
    body: JSON.stringify({
      contents: [{ parts: [{ text: instruction }, { inlineData: { mimeType: page.file.type || "image/png", data: await inlineImage(page.file) } }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema },
    }),
  })
  if (!response.ok) throw new Error(`Gemini trả lỗi ${response.status}. Kiểm tra khóa API, hạn mức và khu vực sử dụng.`)
  const result = await response.json()
  const text = result.candidates?.[0]?.content?.parts?.filter((part) => !part.thought && part.text).map((part) => part.text).join("")
  if (!text) throw new Error("Gemini không trả bản dịch.")
  const rows = JSON.parse(text)
  if (!Array.isArray(rows)) throw new Error("Bản dịch Gemini sai định dạng.")
  return rows.slice(0, 120).flatMap((item) => {
    if (!item || typeof item.text !== "string" || !item.text.trim() || ![item.x, item.y, item.width, item.height].every(Number.isFinite)) return []
    const x = clamp(item.x / 1000, 0, 0.97)
    const y = clamp(item.y / 1000, 0, 0.97)
    const w = clamp(item.width / 1000, 0.03, 1 - x)
    const h = clamp(item.height / 1000, 0.03, 1 - y)
    return [makeBox(page, { x, y, w, h }, item.text.trim())]
  })
}
