# Giao diện Khung Thoại

## Trang tham chiếu

Ảnh chụp Firecrawl trên desktop 1920 px, HTML/CSS công khai và bản phát lại qua Chromium được khảo sát ngày 26/11/2026. Ảnh chụp trang đầu có tiêu đề lớn, nút tải tiện ích Photoshop toàn chiều rộng, một cụm nhập ảnh và lời thoại, cùng cột tìm truyện nhỏ bên phải. Thương hiệu dùng hình biểu tượng thoại. [Trang tham chiếu](https://lilyzono.pages.dev/), [CSS công khai](https://lilyzono.pages.dev/styles.css), [biểu tượng](https://lilyzono.pages.dev/assets/icon.png)

| Thành phần | Giá trị quan sát từ Firecrawl |
|---|---|
| Nền trang và chữ chính | `#F5F3EE` và `#191E29` |
| Nút chính | Nền `#2554CF`, chữ trắng, bo 7 px |
| Trường nhập | Nền `#FFFEFA`, viền `#C9C7C1`, bo 6 px |
| Kiểu chữ | Bricolage Grotesque cho tiêu đề, Be Vietnam Pro cho nội dung |
| Kích thước chữ tại ảnh chụp | H1 khoảng 70 px, H2 khoảng 25 px, nội dung khoảng 16 px |

## Bản dựng

| Vai trò | Giá trị trong CSS |
|---|---|
| Thanh điều hướng | Xanh rừng `#123E32`, chữ trắng |
| Hành động chính | Xanh chanh nhạt `#D4EC83` |
| Nền bàn vẽ | Xanh xám `#ECEFE8` với lưới kẻ chéo |
| Nền thanh công cụ | `#FFFEFA` |
| Chữ, chữ phụ và viền | `#25352D`, `#56675D` và `#D6DFD3` |
| Kiểu chữ | Inter nếu hệ thống đã cài, sau đó dùng font hệ thống |

Trên desktop, danh sách và kịch bản ở bên trái, ảnh ở giữa, bộ điều khiển khung ở bên phải. Thư viện chương mở ở một màn hình riêng. Dưới 950 px, bộ chỉnh khung chuyển xuống dưới. Dưới 610 px, các bảng xếp dọc. Trang dùng trạng thái tiêu điểm rõ cho bàn phím, thông báo động và nhãn riêng cho nút điều hướng. Nguồn triển khai nằm trong [index.html](index.html) và [src/style.css](src/style.css).
