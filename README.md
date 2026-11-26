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

## Biên tập và xuất tệp

1. Thêm tối đa 50 ảnh PNG, JPEG hoặc WebP. Dùng các nút lên và xuống để sắp xếp trang.
2. Dán kịch bản hoặc nhập TXT UTF-8, DOCX, XLSX tối đa 2 MB. Mỗi câu nằm trên một dòng. Dùng tiêu đề như `Trang 1` hoặc `[anh-01.png]` để chỉ trang. Với XLSX, hàng đầu có thể dùng cột `Page` và `Translation`.
3. Bấm **Dàn thoại lên ảnh**. Ứng dụng xếp các câu thành lưới theo hướng đọc đã chọn. Câu có chỉ dẫn trang không khớp hoặc vượt số ô tự động xuất hiện trong **Chưa đặt**.
4. Bấm **+ Khung chữ** rồi kéo hoặc bấm trên ảnh. Khi ảnh được lấy tiêu điểm, Enter đặt một khung ở giữa. Kéo khung đã có để di chuyển. Chọn khung để chỉnh nội dung, font, cỡ chữ, màu, canh, góc xoay và nền.
5. Xuất PNG, PSD chứa lớp chữ chỉnh sửa được, PSD tách các khung thành lớp ảnh, hoặc ZIP chứa cả lượt. Photoshop có thể hỏi cập nhật lớp chữ khi mở PSD. [Tài liệu ag-psd](https://github.com/Agamnentzar/ag-psd#updating-text-layers)

Ảnh và thao tác biên tập được giữ trong phiên mở trang. Tải tệp xuất trước khi làm mới hoặc đóng tab.

## Dịch bằng Gemini

Mở **Dịch ảnh bằng Gemini**, nhập khóa API của bạn, chọn ngôn ngữ và bấm **Dịch trang đang mở**. Trình duyệt gửi ảnh và ghi chú trực tiếp đến Google Generative Language API. Ứng dụng giữ khóa trong trường nhập của phiên hiện tại. Kết quả gồm câu dịch và vị trí gợi ý để bạn chỉnh lại trên ảnh. [Tài liệu Gemini](https://ai.google.dev/api/generate-content)

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
