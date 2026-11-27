# Nixio (Khung Thoại)

Công cụ biên tập, xóa chữ (redraw), OCR, dịch thuật và dàn thoại truyện tranh/manga chạy trên **trình duyệt Web** và **ứng dụng Desktop (Electron + lõi xử lý ảnh C#/.NET 10 tự chứa)**.

Dự án được xây dựng độc lập sau khi khảo sát luồng công khai của Lilyzono, kết hợp kỹ thuật phục hồi kết cấu **PhotoCraft C# Pro** (Multi-Scale PatchMatch nhận biết cấu trúc nét, SIMD `Vector<float>`, Poisson Seamless Blending đa luồng) và kiến trúc **Trợ lý AI Agent Harness v3** (học hỏi & tối ưu từ DeepSeek Harness). Xem thêm [ANALYSIS.md](ANALYSIS.md), [DESIGN.md](DESIGN.md), [docs/architecture.md](docs/architecture.md) (kiến trúc RPC, máy trạng thái, ranh giới tin cậy IPC) và [native/README.md](native/README.md).

---

## Tính năng chính

| Nhóm | Bản Web | Bản Desktop (Electron + C#/.NET 10) |
|---|---|---|
| **Giao diện Pro Workstation** (Light/Dark Mode trung tính phong cách Figma/Clip Studio, **Thanh công cụ dọc 44px** với 11 icon SVG nét mảnh, bàn vẽ lưới chấm tối đa diện tích, Inspector thu gọn dạng Accordion), biên tập khung thoại, co giãn 8 tay cầm (kể cả khung xoay), xoay theo nấc 15°, chọn nhiều khung & căn hàng 6 hướng / chia đều khoảng cách, hút lưới tự động, **Chấm bong bóng tự động** (`bubble`) & **Quét toàn bộ bong bóng trên trang**, **Ghép & Cắt Webtoon thông minh** (dọc khoảng trống không đứt tranh), zoom 25%–400%, kéo bàn vẽ, so sánh gốc (`\`) & **Thanh kéo so sánh gốc Before/After (`Shift + \`)** | Có | Có |
| Dàn chữ nâng cao (viền chữ `stroke`, đổ bóng `shadow`, đậm/nghiêng/IN HOA/chữ dọc, **dàn chữ ôm bong bóng bầu dục**, **uốn chữ SFX** vòng cung/lượn sóng, giãn dòng `0.8–2.2`, hình nền chữ nhật/bầu dục/bo góc, tự khớp cỡ chữ cho khung/trang, **Bộ Mẫu dàn chữ toàn cục + Xuất/Nhập JSON**, nạp & tự lưu font `.ttf`/`.otf`/`.woff`/`.woff2` vào IndexedDB) | Có | Có |
| Cọ retouch thủ công (Hút màu, Cọ vẽ che chữ, Cọ sao chép nền Clone Stamp có **Hòa biên Poisson Seamless**, **Cọ tẩy chữ thông minh Inpaint**, **Cọ tẩy nét redraw**, **Xem trước Xử lý Raw 60fps** & **Làm sạch ảnh Raw từng trang / cả chương**, hoàn tác nét cọ gần nhất, cache offscreen) & mặt nạ vùng xóa cửa sổ trượt | Có (Inpaint JS + Làm sạch raw trên **Web Worker**) | Có (**Inpaint C# Multi-Scale Gradient-Aware SIMD PatchMatch + Poisson Seamless Clone/Blend**, **Làm sạch ảnh raw C# đa luồng** & mặt nạ C# tăng tốc) |
| Xóa chữ tự động (Redraw) | Nền giấy sáng trơn trên Canvas + Cọ Inpaint JS | Nền trơn, nền chuyển sắc, screentone lặp (chu kỳ ≤ 32 px, kể cả screentone chuyển sáng), **Auto Content-Aware Cleanup (PatchMatch C#)** chọn trực tiếp trên từng khung, bảo vệ nét vẽ cắt biên + Cọ Inpaint/Clone C# |
| Dịch & ghép kịch bản bằng **Gemini API** hoặc **OpenAI-compatible / Local LLM** (Ollama, LM Studio, Hy-MT2, OpenRouter) có **tự thử lại (`withLlmRetry`)** + **Dịch các khung chữ đang có** (không cần model Vision) | Có | Có (cho phép kết nối HTTPS và HTTP loopback `localhost`/`127.0.0.1`) |
| **Trợ lý AI · Agent Harness v3** (**AI Vision `inspect_page_image`** soi trực tiếp ảnh đa phương thức Gemini/OpenAI, **Glossary & QA Linter 0-token `lint_chapter_qa`**, **SSE Token & Reasoning Streaming**, **Đo ngân sách ngữ cảnh thực tế `Context Budget Meter`**, **Gom 1 mốc Undo + Thẻ tóm tắt Diff cho cả lượt AI**, `<system-reminder>`, 5 **Hồ sơ kỹ năng theo thể loại**, thẻ hỏi `ask_user`, duyệt thao tác hàng loạt & **Web-Taint Write Gate**, Todo, **Plan Mode**, lệnh nhanh `/qc`, `/plan`, `/autofit`, `/compact ai`, chống lặp công cụ & tự thử lại 429/503, lưu lịch sử chat theo dự án, **Web Search** & **22 công cụ**) | Có (Wikipedia CORS / Tavily / SearXNG) | Có (DuckDuckGo + Jisho + Wikipedia miễn phí qua IPC **pin IP DNS chống SSRF/DNS Rebinding**, hoặc Tavily / SearXNG) |
| **Kiểm tra cập nhật & Trung tâm Thông báo** (kiểm tra GitHub Releases theo SemVer 2.0, ghi chú phát hành, bỏ qua phiên bản; toast có nút 1 chạm cho tràn chữ / nhắc lưu / hoàn tác AI / trạng thái mạng) | Có | Có (qua Electron IPC bảo mật & mở liên kết HTTPS ngoài) |
| OCR cục bộ offline (Tesseract, tiền xử lý phóng lớn/giảm nhiễu/xoay 0–270°, chữ dọc Nhật `jpn_vert`, gom dòng & cửa sổ duyệt kết quả có độ tin cậy) | — | Có |
| Tìm & thay thế toàn chương, xuất kịch bản (`TXT` / `CSV` / `JSON`), **Glossary & QA Linter 0-token** + rà trước khi xuất (**Export Preflight**) | Có | Có |
| Lưu / mở dự án `.khungthoai` v2 (tương thích ngược v1) & tự lưu phục hồi | Tự lưu IndexedDB mỗi 20 giây & khi ẩn tab, mỗi tab/page instance một slot (không dọn bản của tab khác), chọn rõ bản để khôi phục | Dự án gần đây + tối đa 10 mốc tự lưu theo từng dự án, giữ bản `.bak`, tự lưu khi đóng app và bản lưu trình duyệt dự phòng khi worker C# chưa sẵn sàng |
| Xuất tệp | PNG, PSD lớp chữ (kèm Photoshop Layer Style `stroke`/`dropShadow`), PSD lớp ảnh, ZIP | Như Web + ghép & xuất PNG/ZIP trực tiếp bằng C# kèm bảng Tác vụ tiến độ & Hủy |

---

## Cài đặt bản phát hành chính thức (Windows, macOS & Linux)

Tải bộ cài tích hợp sẵn runtime **.NET 10** tự chứa tại trang [GitHub Releases](https://github.com/wiothemilo-lang/Nixio/releases):

| Hệ điều hành | Tệp phát hành | Cách cài đặt |
|---|---|---|
| **Windows 10 / 11 (x64)** | `Khung-Thoai-*-win-x64-setup.exe` | Chạy trình cài đặt Inno Setup (không cần quyền Admin mặc định, tự liên kết tệp `.khungthoai`) |
| **Windows 10 / 11 (Portable)** | `Khung-Thoai-*-win-x64-portable.zip` | Giải nén và mở `Khung-Thoai.exe` |
| **macOS 12+ (Apple Silicon)** | `Khung-Thoai-*-mac-arm64.dmg` | Mở `.dmg` và kéo **Khung Thoại** vào `Applications` |
| **macOS 12+ (Intel)** | `Khung-Thoai-*-mac-x64.dmg` | Mở `.dmg` và kéo **Khung Thoại** vào `Applications` |
| **macOS (Portable)** | `Khung-Thoai-*-mac-arm64.zip` / `Khung-Thoai-*-mac-x64.zip` | Giải nén và mở `Khung-Thoai.app` |
| **Ubuntu / Debian / Mint / Pop!_OS (x64)** | `khung-thoai_*_amd64.deb` | `sudo apt install ./khung-thoai_*_amd64.deb` *(tương thích cả Debian 11/12 và Ubuntu 22.04/24.04 `t64`)* |
| **Fedora Linux (x64)** | `khung-thoai-*-1.x86_64.rpm` | `sudo dnf install ./khung-thoai-*-1.x86_64.rpm` |
| **Linux khác (Portable x64)** | `khung-thoai-*-linux-x64.tar.gz` | Giải nén và chạy `./Khung-Thoai` |

> **OCR cục bộ offline (tùy chọn)**: cài thêm Tesseract cho hệ điều hành của bạn:
> - **Ubuntu / Debian**: `sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-jpn tesseract-ocr-jpn-vert`
> - **Fedora**: `sudo dnf install tesseract tesseract-langpack-eng tesseract-langpack-jpn tesseract-langpack-jpn_vert`
> - **Windows 10 / 11**: `winget install UB-Mannheim.TesseractOCR` (hoặc tải từ [UB-Mannheim Tesseract](https://github.com/UB-Mannheim/tesseract/wiki))
> - **macOS**: `brew install tesseract tesseract-lang`

Kiểm tra toàn vẹn tệp tải về bằng `SHA256SUMS.txt` đi kèm bản phát hành (`sha256sum -c SHA256SUMS.txt`).

---

## Yêu cầu & Chạy từ mã nguồn

Yêu cầu **Node.js 22.12+** (CI chạy **Node.js 24 LTS**). Để biên dịch lõi xử lý ảnh C# trên desktop cần thêm **.NET 10 SDK** (và **Tesseract** nếu dùng OCR cục bộ).

```sh
git clone https://github.com/wiothemilo-lang/Nixio.git
cd Nixio
npm ci
```

### Chạy bản Web

```sh
npm run dev       # Chạy máy chủ phát triển Vite
npm run build     # Build bản production vào dist/
npm run preview   # Xem trước bản production
```

### Chạy & đóng gói App Desktop (Electron + C#)

```sh
npm run desktop:native                  # Biên dịch lõi C# (.NET 10 SDK) vào native/out/
npm run desktop                         # Build web và mở app Electron
npm run desktop:package -- linux-x64    # Đóng gói Electron + runtime .NET vào desktop-dist/
npm run desktop:package -- win-x64      # Tương tự cho Windows x64
npm run desktop:package -- osx-arm64    # macOS Apple Silicon (.app trong desktop-dist/Khung-Thoai-darwin-arm64/)
npm run desktop:package -- osx-x64      # macOS Intel
```

Tạo gói cài đặt phát hành (`.deb`, `.rpm`, `.tar.gz` trên Linux; `.exe` Inno Setup 6 & `.zip` trên Windows; `.app`, `.dmg` & `.zip` trên macOS — kết quả nằm trong `release-dist/`):

```sh
npm run desktop:release -- linux-x64    # Yêu cầu dpkg-deb, rpmbuild, tar
npm run desktop:release -- win-x64      # Yêu cầu Inno Setup 6 (ISCC.exe)
npm run desktop:release -- osx-arm64    # Yêu cầu macOS: ditto, hdiutil, codesign, xcrun notarytool
npm run desktop:release -- osx-x64
```

#### Ký và notarisation bản macOS

`scripts/package-release.mjs` ký `.app` với Hardened Runtime bằng entitlements sinh ra lúc đóng gói, đối chiếu với hai tệp đã commit: `desktop/assets/entitlements.mac.plist` (app) và `desktop/assets/entitlements.mac.inherit.plist` (helper/renderer + worker C#). Các bundle lồng nhau và worker C# được ký trước bằng quyền kế thừa, sau đó mới ký app; tiếp theo là `.dmg` bằng `hdiutil` và `.zip` bằng `ditto`. Bước notarisation (`xcrun notarytool submit --wait` + `xcrun stapler staple`) chỉ chạy khi bật `MAC_NOTARIZE=1` và đọc thông tin xác thực từ biến môi trường:

| Biến môi trường | Ý nghĩa |
|---|---|
| `CODESIGN_IDENTITY` | Chuỗi định danh Developer ID, ví dụ `Developer ID Application: Khung Thoai (ABCDE12345)` |
| `MAC_NOTARIZE` | Đặt `1` để notarise; bỏ trống để chỉ ký cục bộ |
| `APPLE_ID` | Apple ID của tài khoản developer |
| `APPLE_APP_SPECIFIC_PASSWORD` | Mật khẩu ứng dụng riêng cho `notarytool` |
| `APPLE_TEAM_ID` | Team ID 10 ký tự |

Thiếu thông tin xác thực thì lệnh dừng ngay bằng lỗi tiếng Việt (`Thiếu thông tin xác thực notarisation (APPLE_ID, …)`) thay vì đẩy lên một bản `.dmg` không notarise.

**Nhánh không ký (unsigned)**: nếu không đặt `CODESIGN_IDENTITY`, bước ký và notarisation được bỏ qua, `.app`/`.dmg`/`.zip` vẫn được tạo và ghi cảnh báo `CODESIGN_IDENTITY chưa đặt — bỏ qua bước ký`. Người dùng cuối mở bản này bằng chuột phải → **Open**, hoặc gỡ cờ cách ly một lần:

```sh
xattr -dr com.apple.quarantine /Applications/Khung-Thoai.app
```

Bật `MAC_NOTARIZE=1` mà thiếu `CODESIGN_IDENTITY` cũng dừng bằng lỗi tiếng Việt tương ứng — không có bản notarise nào được tạo từ app chưa ký.

---

## Cấu trúc mã nguồn

```text
Nixio/
├── index.html                  # Giao diện Pro Workstation, Tool Rail 44px SVG, Accordion, hộp thoại Webtoon/Raw Preview & AI
├── src/
│   ├── main.js                 # Điểm khởi chạy trình biên tập, phím tắt, Tool Rail, chế độ tối, so sánh kéo rèm & thông báo
│   ├── style.css               # Hệ thống giao diện Pro Workstation (Light & Dark Mode trung tính, không AI slop)
│   ├── canvas.js, tools.js     # Render khung thoại, viền/bóng/dọc, ôm bong bóng, uốn chữ SFX, auto-fit, căn hàng, PSD Layer Style
│   ├── bubble.js, webtoon.js   # Chấm/quét bong bóng thoại (RTL/LTR) & ghép dọc / cắt Webtoon thông minh dọc khoảng trống
│   ├── linter.js, terminology-graph.js  # Glossary & QA Linter 0-token (rà chữ chưa dịch, lệch thuật ngữ, biến thể, dạng cấm, xung đột xưng hô, placeholder, dấu câu)
│   ├── presets.js, theme.js    # Bộ mẫu dàn chữ toàn cục (xuất/nhập JSON) & quản lý Dark/Light Mode
│   ├── cleanup.js, redraw.js   # Mặt nạ vùng xóa chữ (cửa sổ trượt) và hàng đợi redraw ưu tiên (hỗ trợ content_aware_cleanup)
│   ├── retouch.js, inpaint.js, raw-cleanup.js, image-worker.js  # Hút màu, cọ vẽ/sao chép Poisson/tẩy redraw, Inpaint/Raw Cleanup JS + Web Worker
│   ├── gemini.js, openai-compat.js, llm-retry.js, translation.js  # Dịch ảnh/khung thoại Gemini & Local/OpenAI LLM có tự thử lại
│   ├── agent-context.js, agent-harness.js, agent-pipeline.js, agent-tools.js, agent-guards.js, agent-skills.js, agent-commands.js  # Agent Harness v3 (AI Vision, SSE streaming, context budget, 22 công cụ)
│   ├── web-search.js           # Client tìm kiếm web & chuẩn hóa nội dung an toàn
│   ├── notifications.js        # NotificationStore & Trung tâm Thông báo + Toast có nút hành động
│   ├── updater.js              # Kiểm tra cập nhật SemVer 2.0 (Web & Desktop)
│   ├── project.js, history.js, web-storage.js, chat-storage.js, fonts.js, io.js, library.js, ocr.js, placement.js, native.js
│   └── controllers/            # chat, dialogs, export, gestures, ocr, project, tasks, translation
├── desktop/
│   ├── main.cjs, preload.cjs   # Tiến trình chính Electron, CSP, IPC bảo mật & mở liên kết HTTPS ngoài
│   ├── native-worker.cjs, worker.cjs, task-queue.cjs, project-files.cjs, recovery-catalog.cjs
│   ├── web-search.cjs          # DuckDuckGo + Jisho + Wikipedia (DNS IP Pinning chống SSRF/DNS Rebinding & decompression bomb)
│   ├── updater.cjs             # Kiểm tra GitHub Releases API phía tiến trình chính
│   └── assets/
│       ├── icon.svg                        # Icon vector ứng dụng
│       ├── entitlements.mac.plist          # Hardened Runtime entitlements cho .app macOS
│       └── entitlements.mac.inherit.plist  # Quyền kế thừa cho helper/renderer & worker C#
├── native/                     # Lõi xử lý ảnh & lưu trữ C#/.NET 10 (KhungThoai.Redraw.csproj)
│   ├── PatchMatchInpaint.cs    # Multi-Scale Gradient-Aware SIMD PatchMatch + EM Voting + Colour Adaptation + Content-Aware Cleanup
│   ├── PoissonBlend.cs         # Multigrid SOR Poisson Seamless Blending & Seamless Clone Stamp (Parallel.For)
│   ├── RawCleanup.cs, TextureRedraw.cs, GradientRedraw.cs, NativeImaging.cs, LocalOcr.cs, ProjectStorage.cs, NativeRpc.cs
├── docs/
│   └── architecture.md         # Sơ đồ RPC KTR1, máy trạng thái tác vụ/phục hồi, bảng ranh giới tin cậy IPC, checklist thêm operation
├── scripts/
│   ├── desktop-build.mjs       # Build native C# + Vite + @electron/packager (.app trên macOS)
│   ├── package-release.mjs     # Đóng gói .deb / .rpm / .tar.gz / .zip / Inno Setup .exe; .app, .dmg + ký & notarise macOS
│   ├── desktop-smoke.mjs       # Kiểm thử E2E Playwright cho bản Electron đóng gói (giải mã đường dẫn .app trên macOS)
│   ├── benchmark.mjs           # Đối chứng chất lượng redraw/OCR
│   └── agent-eval.mjs          # Chấm output AI offline bằng fixture vàng (glossary, ID, tool, token)
├── test/                       # 36 bộ unit test & integration test (Node.js test runner)
└── .github/workflows/
    ├── verify.yml              # CI Node 24 build, test C#/Node, benchmark, visual, eval & smoke test trên Linux + Windows + macOS
    └── release.yml             # CD Node 24 tự động đóng gói (.deb/.rpm/.tar.gz/.exe/.zip/.dmg) & xuất bản GitHub Release khi gắn tag v*.*.*
```

---

## Hướng dẫn sử dụng công cụ

### 1. Trang truyện, Webtoon, kịch bản và dàn thoại
1. Thêm tối đa **50 ảnh** `PNG`, `JPEG` hoặc `WebP` (≤ 28 MP/ảnh). Kéo thả hoặc dùng nút `↑` / `↓` để sắp xếp thứ tự trang.
2. Dùng nút **Ghép & Cắt Webtoon** trong cột `Trang truyện` để ghép dọc một dải trang thành ảnh cuộn dài, hoặc cắt thông minh trang Webtoon dài dọc theo khoảng trống (smart gutter slicing) mà không làm đứt khung tranh.
3. Dán lời thoại hoặc nhập tệp `TXT` (UTF-8), `DOCX` hoặc `XLSX` tối đa 2 MB (hỗ trợ ngắt dòng/tab trong DOCX, bỏ qua chú âm `<rPh>` trong XLSX). Dùng tiêu đề như `Trang 1`, `[ Trang 1 ]` hoặc `[anh-01.png]` để chỉ định trang; với XLSX hàng đầu có thể dùng cột `Page` và `Translation`.
4. Chọn hướng đọc (`Phải sang trái` / `Trái sang phải`) và bấm **Dàn thoại lên ảnh**. Câu không khớp trang hoặc vượt giới hạn tự động đưa vào mục **Chưa đặt**.
5. Dùng **Xuất kịch bản** để xuất toàn bộ thoại của chương ra **TXT** (nhập lại được ngay), **CSV (UTF-8 BOM cho Excel)** hoặc **JSON**.

### 2. Dàn chữ nâng cao, điều hướng và chỉnh khung trực tiếp
- **Thao tác trực tiếp trên ảnh**:
  - Bấm **+ Khung chữ** rồi bấm/kéo trên ảnh (hoặc nhấn `Enter` khi ảnh đang lấy tiêu điểm), dùng công cụ **Chấm bong bóng tự động** (`bubble`) để bấm 1 chạm tạo khung vừa khít viền bong bóng, hoặc bấm **Quét bong bóng** để nhận diện hàng loạt toàn bộ bong bóng sáng trên trang theo thứ tự đọc RTL/LTR.
  - Chọn khung để kéo di chuyển (có **hút lưới tự động** vào tâm trang và cạnh/tâm các khung lân cận; giữ `Alt` để tạm tắt), kéo **8 tay cầm co giãn** (hỗ trợ chuẩn cả khung đang xoay), hoặc kéo **tay cầm xoay** phía trên (giữ `Shift` để xoay theo nấc 15°).
  - **Chọn nhiều khung (`Shift + bấm`)**: Kéo di chuyển cả nhóm, căn hàng 6 hướng (`Trái`, `Giữa ngang`, `Phải`, `Trên`, `Giữa dọc`, `Dưới`), chia đều khoảng cách (`Chia ngang`, `Chia dọc`), **Khớp cỡ chọn**, áp dụng mẫu hoặc xóa hàng loạt.
  - **Thu phóng 25%–400%** bằng nút `−`/`+`, `Ctrl + cuộn chuột` hoặc chuyển nhanh `Vừa trang` / `Kích thước gốc`.
  - **Kéo bàn vẽ (Pan)** bằng công cụ `Kéo bàn vẽ (Hand)`, giữ `Space + kéo` hoặc kéo chuột giữa.
  - Bấm **So sánh gốc** (phím `\`) để ẩn nhanh lớp redraw và chữ, hoặc bấm **Kéo so sánh** (phím `Shift + \`) để dùng thanh kéo rèm Before/After trực quan. Nút **☾ Tối / ☀ Sáng** trên thanh tiêu đề chuyển đổi nhanh **Chế độ tối (Dark Mode)**.
- **Tùy biến kiểu chữ & xem trước trực tiếp**:
  - Chỉnh **Nội dung**, **Font** (hỗ trợ **+ Nạp font** `.ttf`, `.otf`, `.woff`, `.woff2` từ máy và tự động lưu/khôi phục từ IndexedDB ở các lần mở sau), **Đậm / Nghiêng / IN HOA / Chữ dọc / Ôm bong bóng**, **Uốn chữ SFX** (`arc`, `arcDown`, `wave`), **Cỡ chữ**, **Giãn dòng (`0.8–2.2`)**, **Màu chữ**, **Canh chữ**, **Góc xoay**, **Viền chữ (stroke)**, **Đổ bóng (shadow)** và **Hình nền** (`Chữ nhật`, `Bầu dục`, `Bo góc`) kèm **Màu nền**. Mọi thay đổi đều xem trước trực tiếp trên ảnh.
  - Bấm **Khớp cỡ** hoặc **Khớp cỡ chữ cả trang** để tự chọn cỡ chữ lớn nhất không tràn khung.
  - Dùng **Nhân bản** (`Ctrl/Cmd+D`), **↑ / ↓ Lớp** (đổi thứ tự Z-index) và **Mẫu dàn chữ toàn cục** (có sẵn 4 mẫu manga cơ bản, tự lưu xuyên dự án, hỗ trợ **Xuất JSON / Nhập JSON** dùng chung trong nhóm).

### 3. Xóa chữ tự động & công cụ Retouch thủ công
- **Thanh công cụ dọc 44px (Tool Rail)**: Bám cạnh trái bàn vẽ với 11 công cụ SVG nét mảnh (Khung chữ, Kéo bàn vẽ, Chấm bong bóng, Khoanh vùng xóa, Giữ nền gốc, Thêm vùng xóa, Cọ vẽ, Sao chép nền, Tẩy chữ thông minh, Tẩy nét redraw, Hút màu), tự ẩn/hiện cỡ cọ theo ngữ cảnh.
- **Xóa chữ tự động**: Bật **Xóa chữ gốc trong khung** và chọn chế độ **Tự động** hoặc **Lấp nền thông minh (C# PatchMatch Content-Aware)** ngay trên từng khung thoại. Dùng **Khoanh vùng xóa** để tách vùng xóa khỏi vị trí khung chữ; dùng **Cọ giữ nền gốc** và **Cọ thêm vùng xóa** để tô mặt nạ bảo vệ nét vẽ; chỉnh **Nới / thu mặt nạ (`-8..8 px`)** trên desktop; bấm **Đặt lại vùng xóa** để quay về mặc định.
- **Vẽ che, sao chép nền & làm sạch raw**:
  - **Hút màu (`eyedropper`)**: Bấm vào ảnh để lấy mã màu RGB chính xác cho cọ vẽ (`Shift + bấm` để đổi màu chữ khung đang chọn).
  - **Cọ vẽ che chữ (`paint`)**: Tô màu và độ đục tùy chỉnh trực tiếp lên lớp redraw.
  - **Cọ sao chép nền (`clone`)**: Giữ `Alt + bấm` vào vùng nền/screentone sạch để đặt điểm nguồn, sau đó kéo tô lên chữ cần che. Bật **Hòa biên (Poisson)** trên Desktop để tự động khớp sáng/chuyển sắc biên mượt như Healing Brush.
  - **Cọ tẩy chữ thông minh (`inpaint`)**: Tô trực tiếp lên chữ nằm trên nền tranh phức tạp không lặp (áo, kính màu, tóc, phong cảnh). Trên **Desktop**, lõi **C# Multi-Scale Gradient-Aware SIMD PatchMatch + EM Voting + Colour Adaptation + Poisson Seamless Blending** ([native/PatchMatchInpaint.cs](native/PatchMatchInpaint.cs), [native/PoissonBlend.cs](native/PoissonBlend.cs)) tái tạo kết cấu và giữ liền mạch nét vẽ; trên **Web**, tự động dùng fallback JS Fast-Marching + exemplar ([src/inpaint.js](src/inpaint.js)) — hoàn toàn không chạm điểm ảnh ngoài nét cọ và tự giữ kết quả qua Undo/Redo & xuất tệp.
  - **Cọ tẩy nét redraw (`retouch-erase`)**: Xóa cục bộ nét vẽ/inpaint bị lem lên nét nhân vật.
  - **Làm sạch raw (Xem trước 60fps / Cả chương)**: Mở hộp thoại **Làm sạch ảnh Raw** để kéo ngưỡng cân bằng trắng giấy scan, khử nhiễu JPEG giữ screentone và tăng sắc nét nhẹ với xem trước trực quan theo thời gian thực trước khi áp dụng cho trang đang mở hoặc hàng loạt cả chương (chạy đa luồng C# trên Desktop, chạy nền trên **Web Worker** ở bản Web, hoàn tác 1 bước bằng `Ctrl+Z`).
  - Bấm **Hoàn tác nét cọ** để bỏ nét cọ gần nhất hoặc **Xóa nét vẽ tay** để xóa toàn bộ nét retouch của trang hiện tại. Lớp nét retouch được cache offscreen để kéo khung mượt mà, lưu gọn dạng vector trong `.khungthoai` v2 và gộp tự động vào lớp `Nền đã xóa chữ` khi xuất PNG/PSD/ZIP.
- Dùng checkbox **Hiện redraw** / **Hiện chữ** để kiểm tra từng lớp (không làm mất lớp khi xuất).

### 4. Tìm & thay thế, hoàn tác và phím tắt
- Mở **Tìm & thay** (`Ctrl/Cmd+H` hoặc `Ctrl/Cmd+F`) để tìm kiếm/thay thế xuyên suốt chương (hỗ trợ phân biệt hoa/thường, khớp nguyên từ Unicode, gồm cả câu chưa đặt, tự bảo vệ không làm rỗng hoàn toàn nội dung khung).
- Lịch sử **Hoàn tác / Làm lại** giữ tối đa 40 thao tác trong phiên (tự gom chuỗi giữ phím mũi tên và gom trọn 1 lượt sửa của Trợ lý AI thành 1 mốc Hoàn tác).
- **Lịch sử thao tác có tên** (`Ctrl/Cmd + Shift + H`): mỗi mốc là một câu tiếng Việt cụ thể kèm giờ (`Làm sạch raw trang 1`, `Dịch trang 3`, `Đẩy khung bằng phím`), gõ không dấu vẫn tìm được (`lam sach` khớp "Làm sạch…"), dùng `↑`/`↓` để chọn mốc và `Enter` để nhảy — nhảy lùi vẫn giữ nguyên phần **Làm lại**, còn nút **Về mốc cũ nhất** đưa về trạng thái trước thao tác cũ nhất còn lưu. Một phiên sửa khung hoặc một đợt đẩy khung bằng phím chỉ chiếm đúng một mốc.

| Phím tắt | Tác dụng |
|---|---|
| `Ctrl / Cmd + Z` | Hoàn tác |
| `Ctrl / Cmd + Shift + Z` hoặc `Ctrl + Y` | Làm lại |
| `Ctrl / Cmd + Shift + H` | Mở lịch sử thao tác có tên (tìm & nhảy tới mốc) |
| `Ctrl / Cmd + D` | Nhân bản khung đang chọn |
| `Ctrl / Cmd + H` (hoặc `F`) | Mở hộp thoại Tìm & thay thế |
| `Ctrl + Cuộn chuột` | Thu phóng bàn vẽ (25%–400%) |
| Giữ `Space` + Kéo / Chuột giữa | Kéo bàn vẽ (Pan) |
| `\` | Bật / tắt so sánh ảnh gốc |
| `Shift + \` | Bật / tắt thanh kéo so sánh gốc (Before/After) |
| `Shift` + Kéo tay cầm xoay | Xoay khung theo nấc 15° |
| `Shift` + Bấm khung | Chọn nhiều khung để kéo nhóm / căn hàng |
| `Alt` + Kéo khung | Tạm tắt hút lưới tự động |
| `Alt` + Bấm (khi chọn Cọ sao chép nền) | Đặt điểm nguồn sao chép |
| Phím mũi tên (khi chọn khung) | Dịch khung 1 px (giữ `Shift`: 10 px) |
| `Delete` / `Backspace` | Xóa khung (hoặc nhóm khung) đang chọn |
| `Enter` (khi focus bàn vẽ) | Đặt khung chữ ở giữa trang |
| `?` | Mở bảng phím tắt |

### 5. Dịch ảnh & khung thoại bằng Gemini / Local LLM, OCR cục bộ & Trợ lý AI Harness v3
- **Gemini API & OpenAI-compatible / Local LLM**: Mở **Dịch ảnh & LLM (Gemini / Local)**, chọn **Gemini API** hoặc **OpenAI-compatible / Local LLM** (có cấu hình sẵn cho **Ollama** `http://localhost:11434/v1`, **LM Studio** `http://localhost:1234/v1`, **OpenRouter**, **OpenAI** hoặc server **Hy-MT2 Manga / vLLM** cục bộ; chỉ cho phép HTTPS hoặc HTTP loopback `localhost`/`127.0.0.1` và không bao giờ lưu API key vào `.khungthoai`).
  - **Dịch các khung chữ đang có**: Dịch trực tiếp các khung đã OCR cục bộ bằng Tesseract (hoặc tạo thủ công) mà **không cần model Vision** — tương thích hoàn toàn với các model dịch chữ thuần như Hy-MT2 Manga, Qwen2.5, Llama, Gemma.
  - **Dịch trang đang mở / Dịch cả lượt / Tiếp tục dịch chương / Ghép nghĩa kịch bản**: Hỗ trợ ngữ cảnh qua trang và **Bảng thuật ngữ** (`từ gốc = từ dịch`, kèm chỉ thị `@alias`/`@variant`/`@pos`/`@keep`/`@prefer`/`@forbid` và quan hệ `@broader`/`@narrower`/`@related`/`@conflict`). [Tài liệu Gemini](https://ai.google.dev/api/generate-content)
- **OCR trên máy (Desktop)**: Sau khi cài Tesseract cùng gói ngôn ngữ, dùng mục **OCR trên máy** để tiền xử lý (phóng lớn bilinear 1×–3×, giảm nhiễu, xoay 0/90/180/270°), chọn chế độ chữ dọc Nhật (`jpn_vert`), gom dòng gần nhau và kiểm tra/chỉnh sửa trong cửa sổ duyệt kết quả kèm ảnh cắt và độ tin cậy trước khi **Đặt lên trang**. Xem chi tiết cấu hình trong [native/README.md](native/README.md).
- **Trợ lý AI · Agent Harness v3, AI Vision & Web Search**: Bấm nút **Trợ lý AI** trên thanh tiêu đề để mở khung chat agent đa bước (dùng chung cấu hình **Gemini** hoặc **Local/OpenAI LLM** ở cột trái):
  - **AI Vision (`inspect_page_image`)**: Cho phép AI Agent soi trực tiếp vùng ảnh trang truyện đa phương thức (Gemini `inlineData` & OpenAI `image_url`) để kiểm tra biểu cảm, SFX, ngữ cảnh tranh và tự động tỉa ảnh đính kèm cũ khi nén ngữ cảnh.
  - **Glossary & QA Linter 0-token (`lint_chapter_qa`)**: Rà tức thì toàn chương (không tốn token LLM) để phát hiện chữ chưa dịch, lệch từ điển thuật ngữ (alias/biến thể/dạng bị cấm/xung đột xưng hô), placeholder còn sót, lỗi dấu câu (hỗ trợ tự sửa `autoFixPunctuation`), đồng thời gắn trực tiếp vào bước rà trước khi xuất (**Export Preflight**).
  - **SSE Token & Reasoning Streaming**: Hiển thị câu trả lời và suy luận (`reasoning_content` / `thought`) theo thời gian thực ngay khi sinh ra cho cả Gemini và OpenAI-compat/DeepSeek-R1/Qwen.
  - **Đo ngân sách ngữ cảnh thực tế (`Context Budget Meter`) & Tự nén thông minh**: Đọc token thực từ API (kèm bộ ước lượng dự phòng), hiển thị % ngữ cảnh với cảnh báo màu, tự tỉa kết quả công cụ cũ (`retainHeadTailText`, `pruneOldToolResults`) và hỗ trợ nén tức thì hoặc tóm tắt bằng LLM (`/compact ai`).
  - **Gom 1 mốc Undo cho cả lượt AI + Thẻ tóm tắt Diff**: Mọi thao tác sửa trong 1 lượt AI được gom thành 1 mốc Hoàn tác duy nhất kèm thẻ xem nhanh khung thêm/sửa/xóa và nút **Hoàn tác cả lượt AI này**.
  - **Bộ công cụ Web Search an toàn (`web_search`, `fetch_url`) & Web-Taint Write Gate**: Trên Desktop tự động tra miễn phí qua **DuckDuckGo + Jisho.org + Wikipedia** với **DNS IP Pinning** chống SSRF/DNS rebinding và giới hạn chống decompression bomb; ngay khi lượt chat đọc nội dung web không đáng tin, mọi công cụ ghi tự động yêu cầu người dùng phê duyệt.
  - **22 công cụ biên tập & kiểm tra**: `web_search` (đa truy vấn song song), `fetch_url`, `inspect_page_image`, `lint_chapter_qa`, `get_project_state`, `list_boxes`, `search_chapter_text`, `query_terminology`, `check_export_preflight`, `navigate_page`, `todo_write`, `submit_plan`, `ask_user`, `update_box`, `create_box`, `delete_box`, `replace_chapter_text`, `update_glossary`, `autofit_page`, `align_boxes`, `distribute_boxes`, `apply_style_preset`. Công cụ đọc chạy song song trong pool có giới hạn, công cụ sửa luôn tạo hàng rào tuần tự (exclusive barrier) và chống lặp (`RepeatToolGuard`).
- **Kiểm tra cập nhật & Trung tâm Thông báo**:
  - Bấm **Cập nhật** trên thanh tiêu đề (hoặc để app tự kiểm tra âm thầm 24 giờ/lần khi khởi động) để so sánh SemVer 2.0 với GitHub Releases (`wiothemilo-lang/Nixio`), xem ghi chú phát hành, danh sách tệp tải và tùy chọn **Bỏ qua bản này**.
  - **Trung tâm Thông báo** (nút **Thông báo** có huy hiệu chưa đọc + toast góc dưới phải tự ẩn, tạm dừng khi rê chuột): Tự động cảnh báo **khung tràn chữ** kèm nút 1 chạm **Khớp cỡ cả trang**, **nhắc lưu dự án** khi có nhiều chỉnh sửa chưa lưu ra tệp `.khungthoai`, báo hoàn tất xuất/dịch hàng loạt, báo chỉnh sửa của Trợ lý AI kèm nút **Hoàn tác**, phát hiện mất/có lại kết nối mạng và nhắc bản tự lưu phục hồi.

### 6. Dự án `.khungthoai`, tự lưu và xuất tệp
- **Lưu / Mở dự án**: Tệp `.khungthoai` v2 lưu ảnh gốc, mã dự án phục hồi, thứ tự trang, kịch bản, khung thoại (kể cả kiểu chữ nâng cao, viền, đổ bóng, font tùy chỉnh, vùng xóa, nét cọ), nét retouch (`paint`, `clone`, `inpaint`), mẫu dàn chữ, bảng thuật ngữ và tiến độ dịch (vẫn đọc tương thích ngược tệp v1).
- **Tự lưu phục hồi**:
  - *Bản Web*: Tự lưu phiên hiện tại vào IndexedDB mỗi 20 giây khi có thay đổi và khi ẩn/rời tab. Mỗi bản lưu ghi kèm mã dự án, số hiệu chỉnh sửa, thời điểm và tab đã ghi, và **mỗi page instance sở hữu một slot riêng**: lưu lại chỉ thay slot của chính nó, không bao giờ dọn bản của tab khác, nên hai tab mở hai dự án khác nhau — hoặc cùng một dự án với nội dung lệch nhau, kể cả tab nhân bản chia sẻ `sessionStorage` — đều giữ được bản riêng thay vì ghi đè lẫn nhau. Kho giữ tối đa 8 bản và 3 bản mỗi dự án; khi đã đầy, lần lưu mới bị từ chối kèm hướng dẫn bỏ bớt một bản cũ, các bản đã có vẫn nguyên và phiên hiện tại tiếp tục ở trạng thái chưa lưu. Danh sách **Bản tự lưu trên trình duyệt** hiển thị từng bản (tên tệp, số trang, thời điểm, bản cũ/phiên khác) để chọn đúng bản rồi **Khôi phục bản đã chọn** hoặc **Bỏ bản đã chọn**; bản ghi cũ `latest` của phiên bản trước và font đã nạp được chuyển đổi, giữ nguyên.
  - *Bản Desktop*: **Dự án gần đây và phục hồi** liệt kê từng dự án cùng tối đa 10 mốc tự lưu gần nhất, hỗ trợ mở lại bản tự lưu cũ và giữ bản `.bak` trước khi ghi đè. Trạng thái **Còn thay đổi chưa lưu** phản ánh việc lưu tệp thủ công.
  - *Đóng app*: Chỉ thoát ngay khi thay đổi hiện tại đã nằm trong tệp hoặc một bản tự lưu đọc lại được. Nếu worker C# còn đang khởi động hoặc thiếu, app ghi bản tự lưu trình duyệt dự phòng, xác nhận đúng bản ghi của số hiệu chỉnh sửa hiện tại rồi mới đóng; sửa tiếp trong lúc đang ghi thì bản mới nhất được ghi lại. Khi không ghi được bản nào (kho đầy, trình duyệt chặn, tác vụ chưa xong), app hỏi rõ trước khi bỏ thay đổi và giữ cửa sổ mở nếu người dùng hủy. Lưu dự án thủ công không xóa bản tự lưu nào, và thao tác tải tệp không được tính là đã lưu.
- **Rà trước khi xuất & Xuất tệp**: Kiểm tra câu chưa đặt, chữ tràn khung, trang lỗi/chưa dịch xong trước khi xuất **PNG**, **PSD chữ** (tách `Ảnh gốc`, `Nền đã xóa chữ`, nhóm `Thoại` chỉnh sửa được kèm Photoshop Layer Style `stroke`/`dropShadow` — xem [ag-psd](https://github.com/Agamnentzar/ag-psd#updating-text-layers)), **PSD ảnh**, hoặc **ZIP cả lượt**. Các tác vụ OCR, tiền xử lý và mã hóa PNG hiển thị tiến độ trong bảng **Tác vụ** kèm nút **Hủy** trên worker ảnh tách biệt.

---

## Thư viện chương

Nhập tệp JSON trỏ đến kho ảnh HTTPS hoặc cùng nguồn (hỗ trợ tìm kiếm tiếng Việt không dấu theo tên và tên khác):

```json
{
  "series": [
    {
      "title": "Truyện mẫu",
      "aliases": ["Sample comic"],
      "chapters": [
        {
          "title": "Chương 1",
          "pages": ["https://example.com/comic/01.png", "https://example.com/comic/02.png"]
        }
      ]
    }
  ]
}
```

Chọn truyện và chương để đọc, chuyển ảnh vào trình biên tập hoặc tải ảnh thành ZIP. Máy chủ ảnh cần bật CORS cho thao tác **Đưa vào biên tập** và **Tải ảnh ZIP** khi khác nguồn.

---

## Kiểm thử & CI/CD

Chạy toàn bộ bộ test bằng Node.js 22.12+:

```sh
npm test
```

- **CI (`.github/workflows/verify.yml`)**: Chạy trên GitHub Actions Node 24 (`ubuntu-latest`, `windows-latest` và `macos-15`), thực thi 36 bộ unit/integration test (Node + C#), bộ đối chứng chất lượng ảnh/OCR (`npm run benchmark -- --output artifacts/benchmark.json`), so khớp baseline giao diện biên tập/thư viện trên Linux (`npm run test:visual`), chấm output AI offline bằng fixture vàng (`npm run eval:agent -- --output artifacts/agent-eval.json`, chạy tuần tự sau bước visual) và kiểm thử luồng Electron đóng gói bằng Playwright (`npm run test:desktop -- --packaged`). Xem [nguồn và cách bổ sung mẫu ảnh](test/fixtures/comic/README.md), [quy trình baseline giao diện](test/visual/README.md) và [fixture đánh giá AI](test/eval/fixtures/README.md).
- **CD (`.github/workflows/release.yml`)**: Khi đẩy tag `v*.*.*` (hoặc chạy tay qua `workflow_dispatch`), tự động build, smoke-test trên Linux, Windows & macOS, đóng gói `.deb`, `.rpm`, `.tar.gz`, `.exe` (Inno Setup 6), `.zip`, `.app` + `.dmg` (`macos-15` arm64 và `macos-15-intel` x64, ký Hardened Runtime và notarise khi có secrets `MACOS_CODESIGN_IDENTITY`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`), tạo `SHA256SUMS.txt` và xuất bản GitHub Release.

36 bộ test trong `test/`:
- `placement.test.js` & `ocr.test.js`: Chuẩn hóa tọa độ OCR, gom dòng dọc/ngang và quy tắc ghép khung.
- `io.test.js`: Nhận diện MIME, đọc DOCX/XLSX và gom nhóm thoại.
- `gemini.test.js` & `openai-compat.test.js`: Suy luận MIME ảnh, lọc `<think>`/JSON, tự thử lại `withLlmRetry`, dịch ảnh/khung chữ cho Gemini và OpenAI-compatible/Local LLM, xác thực endpoint chống HTTP từ xa không an toàn.
- `canvas.test.js`, `tools.test.js`, `photocraft-pro.test.js`, `presets-theme.test.js` & `webtoon.test.js`: Dàn chữ (stroke, đổ bóng, dọc, hình nền, ôm bong bóng bầu dục, uốn chữ SFX, auto-fit, PSD Layer Style), làm sạch ảnh raw (kể cả `strength: 0` & pixel trong suốt), cọ tẩy nét redraw, mẫu dàn chữ toàn cục JSON I/O, Dark/Light Mode, ghép dọc & cắt thông minh Webtoon dọc khoảng trống, co giãn 8 tay cầm, hút lưới, căn hàng/chia đều, xoay, nhân bản, lớp Z-index, tìm & thay thế, xuất kịch bản.
- `bubble.test.js`: Tự nhận diện bong bóng thoại đơn & quét hàng loạt bong bóng theo thứ tự đọc RTL/LTR.
- `retouch.test.js`, `retouch-export.test.js`, `inpaint.test.js` & `cleanup.test.js`: Hút màu, cọ paint/clone/seamless-clone/erase, giữ kết quả inpaint & seamless clone qua Undo/Xuất, Inpaint JS fallback không chạm ngoài mặt nạ, cache lớp retouch và thuật toán nới/thu mặt nạ cửa sổ trượt.
- `project.test.js`, `recovery-catalog.test.js`, `task-queue.test.js` & `workflow.test.js`: Lưu/mở `.khungthoai` v1/v2, danh mục phục hồi theo dự án, hàng đợi tác vụ có hủy và khôi phục lỗi worker, lịch sử Undo/Redo, đồng bộ `translationNotes`/skill và tiếp tục dịch chương.
- `redraw.test.js`, `native-redraw.test.js`, `native-processing.test.js` & `benchmark.test.js`: Hàng đợi redraw, phục hồi screentone/gradient, PatchMatch SIMD + Poisson seamless inpaint, `seamless_clone` & `content_aware_cleanup` C#, làm sạch raw C# đa luồng, mặt nạ, PNG/ZIP, lưu tệp nguyên tử và benchmark chất lượng từ worker C# (tự động kích hoạt sau khi chạy `npm run desktop:native`).
- `agent-harness.test.js`, `agent-context.test.js`, `harness-pro.test.js`, `linter-vision.test.js`, `terminology-graph.test.js`, `web-search.test.js`, `updater.test.js`, `notifications.test.js`, `release-packaging.test.js` & `release-macos.test.js`: Pipeline Harness song song/tuần tự, AI Vision (`inspect_page_image`) & tỉa ảnh đính kèm cũ, đồ thị thuật ngữ (alias/biến thể/dạng cấm/quan hệ, resolver, migration glossary phẳng) & QA Linter 0-token (`lint_chapter_qa`), SSE streaming (Gemini & OpenAI/DeepSeek-R1), `Context Budget Meter`, turn box diffs, Web-Taint Write Gate, DNS IP Pinning chống SSRF/decompression bomb, nén lịch sử, chống lặp công cụ, tự thử lại LLM, hồ sơ kỹ năng, lệnh nhanh slash, `ask_user`, Plan Mode, Todo list, kiểm tra cập nhật SemVer, Trung tâm Thông báo, sinh cấu hình đóng gói `.deb`/`.rpm`/Inno Setup `.exe` và cấu hình macOS (`.app`/`.dmg`/`.zip` cho arm64 & x64, entitlements Hardened Runtime khớp tệp đã commit, lỗi tiếng Việt khi thiếu thông tin notarisation, quy ước tên tệp phát hành).
- `visual-diff.test.js` & `scripts/visual-regression.mjs`: So khớp ảnh chụp biên tập Sáng/Tối và Thư viện với baseline PNG đã commit trên Linux, ngưỡng sai lệch theo nền tảng, artifact diff trong CI và lệnh cập nhật baseline chỉ dành cho người vận hành (`VISUAL_BASELINE_APPROVAL=1`, từ chối chạy trong CI).
- `test/eval/agent-eval.test.js` & `scripts/agent-eval.mjs`: Chấm output AI hoàn toàn offline bằng corpus fixture vàng có version (`test/eval/fixtures/`), tái dùng parser, translation routing, `runAgentTurn` và `lintChapter` thật với provider giả lập cùng stub tool registry: tuân glossary, độ phủ ID, precision/recall/thứ tự tool, số bước và token/case (nhãn simulated); chặn mọi endpoint ngoài fixture và làm CI đỏ khi regression.
