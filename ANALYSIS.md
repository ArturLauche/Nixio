# Phân tích Lilyzono

Mục tiêu là xác định các luồng công khai của Lilyzono làm cơ sở cho bản dựng độc lập. Nguồn khảo sát gồm ảnh chụp trang, HTML, CSS và JavaScript do máy chủ phát hành lúc khảo sát ngày 26/11/2026. [Trang đã khảo sát](https://lilyzono.pages.dev/)

## Bằng chứng REA

REA 6.10.1 chạy `inspect-web-page` và `analyze-web-bundle` trên bản phát lại Chromium của các tài nguyên đã tải. Các yêu cầu ngoài HTML, CSS và JavaScript chính trong bản phát lại bị chặn. REA ghi nhận một frame, 705 nút DOM và một script cùng nguồn. Phân tích bundle duyệt 12.461 nút cú pháp trong script chính. Không có URL source map trong bản ghi script đó.

- Bằng chứng trình duyệt `ev_26111b18422722c5a8c7b63dfcc6b184d5f2a0eea94ce26348014192470499c6`
- Bằng chứng bundle `ev_f26457ed57c4535bb826e6ac0aae535d3e9ac06205c4cacc331a74f163de92fb`

| Tài nguyên | Kích thước | SHA-256 |
|---|---:|---|
| [HTML](https://lilyzono.pages.dev/) | 20.697 byte | `56b1c2d77dde798be36f4c6237e634cfad99bce21c14eef39660f27e90379a18` |
| [CSS](https://lilyzono.pages.dev/styles.css) | 22.120 byte | `473735b56c43faddbc45bd2425a53ca6050045ebba3f8b082be57f04e722bfd6` |
| [Bundle JavaScript](https://lilyzono.pages.dev/assets/lilyzono.js) | 50.049 byte | `7db58c15b3b41431e89728add33dab9df8fdafdd7b63a0491d54b459afe60e7b` |

## Luồng chức năng

| Khu vực | Hành vi quan sát trên Lilyzono | Bản dựng Khung Thoại |
|---|---|---|
| Chuẩn bị | Tải nhiều ảnh, chọn bản dịch hoặc dán thoại, chọn hướng đọc | Tải ảnh, đổi thứ tự và nhập TXT, DOCX, XLSX hoặc thoại dán. Ghép theo chỉ dẫn trang và đặt câu vào lưới. |
| Dịch | Giao diện cung cấp Hy-MT2 Manga và Gemini, với ghi chú thuật ngữ | Dùng Gemini bằng khóa của người dùng. Phản hồi JSON gồm thoại và vùng gợi ý. |
| Chỉnh thoại | Chuyển trang, chèn và chỉnh vùng chữ, hiển thị câu chưa gán | Di chuyển và chỉnh từng khung. Có danh sách câu chờ đặt cho tiêu đề trang không khớp. |
| Xuất | PNG, PSD lớp chữ, PSD lớp ảnh và ZIP | Xuất từ Canvas và ag-psd, với cả tệp theo trang và ZIP theo lượt. |
| Đọc raw | Ô tìm truyện, chọn chương, đọc và tải ZIP | Tìm trong danh mục JSON do người dùng cung cấp. Có trình đọc, chuyển ảnh vào biên tập và tải ZIP. |

### Phạm vi xác minh

Lilyzono báo chưa kết nối được máy chủ lúc khảo sát. Chất lượng dịch Hy-MT2, ghép nghĩa Nhật–Việt, dữ liệu nguồn truyện và hành vi của tiện ích Photoshop vẫn chưa được xác minh. Tiện ích Photoshop xuất hiện dưới dạng liên kết tải riêng. Kết quả REA bao quát bundle chính trong lần phát lại đã giới hạn nguồn.
