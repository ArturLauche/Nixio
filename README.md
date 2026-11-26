# Better-redraw-and-translate-tool
use this tool for redrawing and translating comic, manga,...

## Khung Thoại

Trình biên tập trang truyện chạy trong trình duyệt, kết hợp nhập lời thoại, đặt khung trên ảnh và xuất tệp để tiếp tục chỉnh sửa. Dự án được viết độc lập sau khi khảo sát giao diện công khai của Lilyzono. Xem [ghi chép phân tích](ANALYSIS.md) và [tài liệu giao diện](DESIGN.md).

## Chạy tại máy

Dùng Node.js 22.12+ hoặc 24 LTS.

```sh
npm ci
npm run dev
```

Mở địa chỉ mà Vite in ra. Dùng `npm run build` để tạo thư mục `dist/` và `npm run preview` để kiểm tra bản build.

## App Electron

Để mở bản desktop từ mã nguồn, cài Node.js 22.12+ và chạy `npm ci` rồi `npm run desktop`. Biên dịch lõi C# bằng .NET 10 SDK trước khi mở app để bật phục hồi nền chấm lặp và nền chuyển sắc.

```sh
npm run desktop:native
npm run desktop
```

Để đóng gói app kèm lõi C#, chọn nền tảng đích. Bản đóng gói chứa runtime .NET cần thiết.

```sh
npm run desktop:package -- linux-x64
npm run desktop:package -- win-x64
```

Kết quả nằm trong `desktop-dist/`. Mở `Khung-Thoai` trên Linux hoặc `Khung-Thoai.exe` trên Windows. Các lệnh đóng gói cần kết nối mạng khi chưa có Electron và runtime .NET cho nền tảng đích trong bộ nhớ đệm.

## Biên tập và xuất tệp

1. Thêm tối đa 50 ảnh PNG, JPEG hoặc WebP. Dùng các nút lên và xuống để sắp xếp trang.
2. Dán kịch bản hoặc nhập TXT UTF-8, DOCX, XLSX tối đa 2 MB. Mỗi câu nằm trên một dòng. Dùng tiêu đề như `Trang 1` hoặc `[anh-01.png]` để chỉ trang. Với XLSX, hàng đầu có thể dùng cột `Page` và `Translation`.
3. Bấm **Dàn thoại lên ảnh**. Ứng dụng xếp các câu thành lưới theo hướng đọc đã chọn. Câu có chỉ dẫn trang không khớp hoặc vượt số ô tự động xuất hiện trong **Chưa đặt**.
4. Bấm **+ Khung chữ** rồi kéo hoặc bấm trên ảnh. Khi ảnh được lấy tiêu điểm, Enter đặt một khung ở giữa. Kéo khung đã có để di chuyển. Chọn khung để chỉnh nội dung, font, cỡ chữ, màu, canh, góc xoay và nền.
5. Xuất PNG, PSD chứa lớp chữ chỉnh sửa được, PSD tách các khung thành lớp ảnh, hoặc ZIP chứa cả lượt. PSD có thể chứa riêng ảnh gốc, phần nền đã xóa chữ và nhóm thoại. Photoshop có thể hỏi cập nhật lớp chữ khi mở PSD. [Tài liệu ag-psd](https://github.com/Agamnentzar/ag-psd#updating-text-layers)

Ảnh và thao tác biên tập được giữ trong phiên mở trang. Tải tệp xuất trước khi làm mới hoặc đóng tab.

## Dịch bằng Gemini

Mở **Dịch ảnh bằng Gemini**, nhập khóa API, chọn ngôn ngữ rồi bấm **Dịch trang đang mở** hoặc **Dịch cả lượt**. Gemini đọc chữ và khung trước, sau đó dịch theo mã thoại. Khi dịch nhiều trang, câu dịch gần nhất được dùng làm ngữ cảnh cho trang sau. Trình duyệt gửi ảnh và ghi chú trực tiếp đến Google Generative Language API. Ứng dụng giữ khóa trong trường nhập của phiên hiện tại. [Tài liệu Gemini](https://ai.google.dev/api/generate-content)

Nếu đã có bản dịch, nhập kịch bản rồi bấm **Ghép nghĩa kịch bản trang này**. Dịch và ghép nghĩa đều ưu tiên khung có sẵn trên trang. Khi trang trống, chúng dùng khung OCR. Các câu không có tọa độ đáng tin cậy hoặc xung đột được giữ trong **Chưa đặt** để xử lý thủ công.

Tùy chọn **Xóa chữ gốc trong khung** lấy mẫu màu giấy quanh khung. Lõi C# của app Electron xử lý nền trơn, nền chuyển sắc và screentone lặp, kể cả screentone đổi độ sáng theo nền. Với nền chuyển sắc, app giữ nguyên nét đậm nối từ trong ra ngoài khung. Vùng ảnh thiếu mẫu đủ tin cậy được giữ nguyên. Kiểm tra ảnh xem trước khi xuất.

## Kiểm thử

Chạy `npm test` để kiểm tra tọa độ OCR và quy tắc ghép khung. Sau khi chạy `npm run desktop:native`, bộ test còn kiểm tra phục hồi texture, dữ liệu sai và thứ tự phản hồi từ tiến trình C#. Xem [kết quả kiểm thử đối chứng](ANALYSIS.md#kiểm-thử-đối-chứng) để biết các hành vi đã được kiểm tra với Lilyzono.

## Thư viện chương

Nhập tệp JSON trỏ đến kho ảnh của bạn. Mỗi truyện có thể có nhiều chương và tên thay thế để tìm kiếm.

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

Chọn truyện và chương để đọc, chuyển ảnh vào trình biên tập hoặc tải ảnh thành ZIP. Máy chủ ảnh cần cho phép CORS đối với thao tác tải ZIP và chuyển vào trình biên tập khi chạy khác nguồn.
