# Build phát hành tái lập (reproducible release builds)

Mục tiêu: hai lần build Linux từ cùng một commit nguồn phải cho artifact `.deb` / `.rpm` / `.tar.gz` giống nhau từng byte (cùng SHA-256). Tài liệu này liệt kê các đầu vào đã được pin, cách kiểm chứng, và phần còn lại chưa tái lập được.

## Đầu vào đã pin

| Đầu vào | Cơ chế pin |
|---|---|
| Dependency JS | `package-lock.json` + `npm ci` trong CI |
| Dependency .NET | `native/packages.lock.json` (committed) + `<RestorePackagesWithLockFile>` + `<RestoreLockedMode>` trong `KhungThoai.Redraw.csproj`; `desktop-build.mjs` truyền thêm `-p:RestoreLockedMode=true`. Locked restore **fail** khi dependency thay đổi mà lock file chưa cập nhật |
| Builder .NET | `<ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>` + `<Deterministic>true</Deterministic>` — tắt timestamp/đường dẫn tuyệt đối trong PE/assembly |
| Timestamp archive | `SOURCE_DATE_EPOCH` (giây Unix). Nếu không set, fallback về commit time của `git HEAD` — cùng nguồn luôn ra cùng epoch. `resolveSourceDateEpoch()` throw nếu cả hai đều không có |
| `.tar.gz` | `tar --sort=name --dereference --mtime=@<epoch> --owner=0 --group=0 --numeric-owner` + `gzip -n` (bỏ tên file & timestamp trong header gzip) |
| `.deb` | `normalizeTreeTimestamps()` đặt mtime mọi file/thư mục/symlink trong staging về epoch trước `dpkg-deb --build`; `--root-owner-group` chuẩn hoá owner |
| `.rpm` | spec sinh bởi `buildRpmSpec()` chạy `find %{buildroot} -exec touch -h -d "@<epoch>"` sau `cp -a` để xoá mtime gốc của `desktop-dist` |
| Thứ tự file | `--sort=name` của GNU tar; manifest sắp xếp input theo code-unit (không phụ thuộc locale) |
| Phiên bản builder | `release-manifest.json` ghi `node`, `dotnet --version`, `tar`, `gzip`, `dpkg-deb`, `rpmbuild` để đối chiếu khi digest lệch |

## Manifest & kiểm chứng

- `scripts/package-release.mjs` (qua `packageRelease()`) luôn ghi `release-manifest.json` vào thư mục output: danh sách input (`package.json`, `package-lock.json`, csproj, `packages.lock.json`, toàn bộ `native/*.cs`, scripts build, workflow release…) kèm `sha256` + kích thước, `sourceDateEpoch`, git commit và phiên bản builder.
- `scripts/verify-release-repro.mjs <rid> [version] [--app] [--keep]` build hai lần liên tiếp (tuỳ chọn build lại cả app Electron bằng `--app`) rồi so `diffArtifactSets()` trên SHA-256 từng artifact. Kết quả ghi `release-verify/reproducibility-report.json`; exit code khác 0 khi có artifact thiếu hoặc digest lệch — digest lệch **chặn publish**.
- `.github/workflows/release.yml` có job `verify-linux-repro` chạy `verify-release-repro.mjs linux-x64 --app`; job `publish` phụ thuộc job này.

Chạy tay:

```sh
npm run desktop:package -- linux-x64          # cần desktop-dist/ sẵn có
node scripts/verify-release-repro.mjs linux-x64 1.3.0          # chỉ so packaging
node scripts/verify-release-repro.mjs linux-x64 1.3.0 --app    # build app 2 lần + package 2 lần
SOURCE_DATE_EPOCH=1700000000 node scripts/package-release.mjs linux-x64
```

## Phần còn chưa tái lập (và lý do)

- **Electron binary**: `@electron/packager` tải zip Electron từ GitHub Releases theo version trong `package-lock.json`. Version được pin nhưng nội dung zip phụ thuộc upstream (trên thực tế release GitHub bất biến, song repo không hash-pin zip).
- **.NET SDK patch version**: CI dùng `dotnet-version: 10.0.x` (floating). Hai job cách nhau có thể resolve hai patch SDK khác nhau → worker native khác byte. Manifest ghi `dotnet --version` để phát hiện; muốn gate chặt cần pin exact version.
- **`.deb` internals**: thứ tự member trong `data.tar`/`control.tar` và header `ar` phụ thuộc phiên bản `dpkg-deb`. Đã chuẩn hoá mtime/owner của cây file và `SOURCE_DATE_EPOCH`, nhưng đổi phiên bản dpkg vẫn có thể đổi byte.
- **`.rpm` internals**: payload ordering, nén xz và build-time tag phụ thuộc phiên bản `rpmbuild`; `SOURCE_DATE_EPOCH` được kế thừa và spec đã chuẩn hoá mtime buildroot.
- **Windows**: Inno Setup (`ISCC.exe`) và `7z`/`Compress-Archive` chưa được chuẩn hoá timestamp/ordering — artifact Windows **không** cam kết byte-identical (acceptance chỉ yêu cầu Linux).
- **asar**: thứ tự entry trong archive do `@electron/packager`/`asar` quyết định theo thứ tự duyệt file; chưa có sort tường minh.
- **Native worker**: `PublishSingleFile`+`PublishTrimmed` deterministic khi cùng SDK + `ContinuousIntegrationBuild`, nhưng đổi RID hoặc SDK vẫn đổi byte (kỳ vọng đúng).
- Gate so sánh **hai lần build trong cùng một job** (cùng toolchain resolve một lần); chưa so chéo digest giữa các job CI độc lập.
