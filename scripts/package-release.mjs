import { createHash } from "node:crypto"
import {
  chmodSync,
  closeSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"

const root = fileURLToPath(new URL("..", import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))

export const APP_NAME = "Khung Thoại"
export const PACKAGE_ID = "khung-thoai"
export const APP_BINARY = "Khung-Thoai"
export const INNO_APP_ID = "{{7B6A2E3F-9C4D-4E5A-8B1F-4A9E6D2C8F01}"
export const HOMEPAGE = "https://github.com/wiothemilo-lang/Nixio"

export function normalizeVersion(raw = pkg.version) {
  const clean = String(raw || pkg.version || "1.0.0").trim().replace(/^v/i, "")
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(clean)) {
    throw new Error(`Invalid release version: ${raw}`)
  }
  return clean
}

export function rpmVersionParts(version) {
  const [base, pre] = normalizeVersion(version).split("-", 2)
  const release = pre ? `0.1.${pre.replace(/[^0-9A-Za-z.]/g, "_")}` : "1"
  return { version: base, release }
}

export function buildDesktopEntry() {
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${APP_NAME}`,
    "GenericName=Manga & Comic Editor",
    "Comment=Biên tập, xóa chữ (redraw), dịch thuật và dàn thoại truyện tranh",
    `Exec=/usr/bin/${PACKAGE_ID} %U`,
    `Icon=${PACKAGE_ID}`,
    "Terminal=false",
    "Categories=Graphics;2DGraphics;Utility;",
    "Keywords=manga;comic;redraw;translate;typeset;ocr;",
    "StartupWMClass=Khung-Thoai",
    "MimeType=application/x-khung-thoai;",
    "",
  ].join("\n")
}

export function buildMimeXml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">',
    '  <mime-type type="application/x-khung-thoai">',
    "    <comment>Khung Thoại Project</comment>",
    '    <glob pattern="*.khungthoai"/>',
    "  </mime-type>",
    "</mime-info>",
    "",
  ].join("\n")
}

export function buildLinuxLauncher() {
  return [
    "#!/bin/sh",
    `exec /opt/${PACKAGE_ID}/${APP_BINARY} "$@"`,
    "",
  ].join("\n")
}

export function buildDebianControl({ version, arch = "amd64", installedSizeKb = 0 } = {}) {
  const ver = normalizeVersion(version)
  return [
    `Package: ${PACKAGE_ID}`,
    `Version: ${ver}`,
    "Section: graphics",
    "Priority: optional",
    `Architecture: ${arch}`,
    ...(installedSizeKb > 0 ? [`Installed-Size: ${installedSizeKb}`] : []),
    "Maintainer: Khung Thoai Maintainers <noreply@github.com>",
    `Homepage: ${HOMEPAGE}`,
    "Depends: libgtk-3-0 | libgtk-3-0t64, libnss3, libgbm1, libxss1, libasound2 | libasound2t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libdrm2",
    "Recommends: tesseract-ocr, tesseract-ocr-eng, tesseract-ocr-jpn-vert",
    "Description: Khung Thoai - Manga redraw, translate, OCR and typesetting studio",
    " Desktop editor for manga and comic scanlation with C#/.NET 10 texture redraw",
    " & multi-scale PatchMatch inpaint, local Tesseract OCR, Gemini / Local LLM",
    " translation, and AI Agent Harness with Web Search.",
    "",
  ].join("\n")
}

export function buildDebianPostinst() {
  return [
    "#!/bin/sh",
    "set -e",
    `if [ -f "/opt/${PACKAGE_ID}/chrome-sandbox" ]; then`,
    `  chown root:root "/opt/${PACKAGE_ID}/chrome-sandbox" || true`,
    `  chmod 4755 "/opt/${PACKAGE_ID}/chrome-sandbox" || true`,
    "fi",
    "if command -v update-desktop-database >/dev/null 2>&1; then",
    "  update-desktop-database -q /usr/share/applications || true",
    "fi",
    "if command -v update-mime-database >/dev/null 2>&1; then",
    "  update-mime-database /usr/share/mime >/dev/null 2>&1 || true",
    "fi",
    "if command -v gtk-update-icon-cache >/dev/null 2>&1; then",
    "  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true",
    "fi",
    "",
  ].join("\n")
}

export function buildDebianPostrm() {
  return [
    "#!/bin/sh",
    "set -e",
    "if command -v update-desktop-database >/dev/null 2>&1; then",
    "  update-desktop-database -q /usr/share/applications || true",
    "fi",
    "if command -v update-mime-database >/dev/null 2>&1; then",
    "  update-mime-database /usr/share/mime >/dev/null 2>&1 || true",
    "fi",
    "",
  ].join("\n")
}

export function buildRpmSpec({ version, sourceDir, iconPath, arch = "x86_64" }) {
  const { version: rpmVer, release: rpmRel } = rpmVersionParts(version)
  return [
    "%define _build_id_links none",
    "%global debug_package %{nil}",
    "%global __strip /bin/true",
    `Name:           ${PACKAGE_ID}`,
    `Version:        ${rpmVer}`,
    `Release:        ${rpmRel}`,
    "Summary:        Khung Thoai - Manga redraw, translate, OCR and typesetting studio",
    "License:        MIT",
    `URL:            ${HOMEPAGE}`,
    `BuildArch:      ${arch}`,
    "AutoReqProv:    no",
    "Requires:       gtk3, nss, libXScrnSaver, mesa-libgbm, alsa-lib, at-spi2-atk, libdrm",
    "Recommends:     tesseract, tesseract-langpack-eng, tesseract-langpack-jpn_vert",
    "",
    "%description",
    "Desktop editor for manga and comic scanlation with C#/.NET 10 texture redraw",
    "& multi-scale PatchMatch inpaint, local Tesseract OCR, Gemini / Local LLM",
    "translation, and AI Agent Harness with Web Search.",
    "",
    "%install",
    `mkdir -p %{buildroot}/opt/${PACKAGE_ID}`,
    `mkdir -p %{buildroot}/usr/bin`,
    `mkdir -p %{buildroot}/usr/share/applications`,
    `mkdir -p %{buildroot}/usr/share/icons/hicolor/scalable/apps`,
    `mkdir -p %{buildroot}/usr/share/mime/packages`,
    `cp -a "${sourceDir}/." "%{buildroot}/opt/${PACKAGE_ID}/"`,
    `cat << 'EOF' > "%{buildroot}/usr/bin/${PACKAGE_ID}"`,
    buildLinuxLauncher().trimEnd(),
    "EOF",
    `chmod 0755 "%{buildroot}/usr/bin/${PACKAGE_ID}"`,
    `cat << 'EOF' > "%{buildroot}/usr/share/applications/${PACKAGE_ID}.desktop"`,
    buildDesktopEntry().trimEnd(),
    "EOF",
    `cp "${iconPath}" "%{buildroot}/usr/share/icons/hicolor/scalable/apps/${PACKAGE_ID}.svg"`,
    `cat << 'EOF' > "%{buildroot}/usr/share/mime/packages/${PACKAGE_ID}.xml"`,
    buildMimeXml().trimEnd(),
    "EOF",
    "",
    "%post",
    `if [ -f "/opt/${PACKAGE_ID}/chrome-sandbox" ]; then`,
    `  chown root:root "/opt/${PACKAGE_ID}/chrome-sandbox" || true`,
    `  chmod 4755 "/opt/${PACKAGE_ID}/chrome-sandbox" || true`,
    "fi",
    "update-desktop-database -q /usr/share/applications >/dev/null 2>&1 || true",
    "update-mime-database /usr/share/mime >/dev/null 2>&1 || true",
    "gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor >/dev/null 2>&1 || true",
    "",
    "%postun",
    "update-desktop-database -q /usr/share/applications >/dev/null 2>&1 || true",
    "update-mime-database /usr/share/mime >/dev/null 2>&1 || true",
    "",
    "%files",
    `/opt/${PACKAGE_ID}`,
    `/usr/bin/${PACKAGE_ID}`,
    `/usr/share/applications/${PACKAGE_ID}.desktop`,
    `/usr/share/icons/hicolor/scalable/apps/${PACKAGE_ID}.svg`,
    `/usr/share/mime/packages/${PACKAGE_ID}.xml`,
    "",
  ].join("\n")
}

export function buildInnoSetupScript({ version, sourceDir, outputDir, outputBaseName }) {
  const ver = normalizeVersion(version)
  const numericVer = ver.split("-", 1)[0]
  const winSource = sourceDir.replace(/\//g, "\\")
  const winOut = outputDir.replace(/\//g, "\\")
  return [
    "[Setup]",
    `AppId=${INNO_APP_ID}`,
    `AppName=${APP_NAME}`,
    `AppVersion=${ver}`,
    `AppVerName=${APP_NAME} ${ver}`,
    "AppPublisher=Khung Thoai",
    `AppPublisherURL=${HOMEPAGE}`,
    `AppSupportURL=${HOMEPAGE}/issues`,
    `AppUpdatesURL=${HOMEPAGE}/releases`,
    `DefaultDirName={autopf}\\Khung Thoai`,
    `DefaultGroupName=${APP_NAME}`,
    "DisableProgramGroupPage=yes",
    "PrivilegesRequired=lowest",
    "PrivilegesRequiredOverridesAllowed=dialog",
    `OutputDir=${winOut}`,
    `OutputBaseFilename=${outputBaseName}`,
    "Compression=lzma2/ultra64",
    "SolidCompression=yes",
    "WizardStyle=modern",
    "ArchitecturesAllowed=x64compatible",
    "ArchitecturesInstallIn64BitMode=x64compatible",
    `VersionInfoVersion=${numericVer}.0`,
    "ChangesAssociations=yes",
    "",
    "[Languages]",
    'Name: "english"; MessagesFile: "compiler:Default.isl"',
    "",
    "[Tasks]",
    'Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional icons:"',
    "",
    "[Files]",
    `Source: "${winSource}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs`,
    "",
    "[Icons]",
    `Name: "{autoprograms}\\${APP_NAME}"; Filename: "{app}\\${APP_BINARY}.exe"`,
    `Name: "{autodesktop}\\${APP_NAME}"; Filename: "{app}\\${APP_BINARY}.exe"; Tasks: desktopicon`,
    "",
    "[Registry]",
    `Root: HKA; Subkey: "Software\\Classes\\.khungthoai"; ValueType: string; ValueName: ""; ValueData: "KhungThoai.Project"; Flags: uninsdeletevalue`,
    `Root: HKA; Subkey: "Software\\Classes\\KhungThoai.Project"; ValueType: string; ValueName: ""; ValueData: "Khung Thoai Project"; Flags: uninsdeletekey`,
    `Root: HKA; Subkey: "Software\\Classes\\KhungThoai.Project\\shell\\open\\command"; ValueType: string; ValueName: ""; ValueData: """{app}\\${APP_BINARY}.exe"" ""%1"""`,
    "",
    "[Run]",
    `Filename: "{app}\\${APP_BINARY}.exe"; Description: "Launch ${APP_NAME}"; Flags: nowait postinstall skipifsilent`,
    "",
  ].join("\r\n")
}

export const MAC_APP_BUNDLE = `${APP_BINARY}.app`
export const MAC_ARCHITECTURES = ["arm64", "x64"]
export const MAC_TARGETS = ["app", "dmg", "zip"]
export const MAC_BUNDLE_ID = "com.khungthoai.editor"
const MAC_SIGNING_KEYS = { appleId: "APPLE_ID", password: "APPLE_APP_SPECIFIC_PASSWORD", teamId: "APPLE_TEAM_ID" }
const MACHO_MAGIC = new Set([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe])

function plistDict(entries) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    ...Object.entries(entries).flatMap(([key, value]) => [`\t<key>${key}</key>`, `\t<${value ? "true" : "false"}/>`]),
    "</dict>",
    "</plist>",
    "",
  ].join("\n")
}

// The hardened runtime needs these grants for Chromium's JIT, the bundled .NET worker and the
// network/file channels the main process already exposes behind IPC.
export function macEntitlements() {
  return plistDict({
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
    "com.apple.security.cs.allow-dyld-environment-variables": true,
    "com.apple.security.cs.disable-library-validation": true,
    "com.apple.security.network.client": true,
    "com.apple.security.files.user-selected.read-write": true,
  })
}

// Renderer, GPU and helper processes cannot carry their own grants: they inherit the parent's.
export function macInheritedEntitlements() {
  return plistDict({
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
    "com.apple.security.inherit": true,
  })
}

export function macPackagerOptions() {
  return { appBundleId: MAC_BUNDLE_ID, appCategoryType: "public.app-category.graphics-design" }
}

// The worker resolver and @electron/packager call macOS "darwin", while the RID advertised by
// desktop-build.mjs and the C# worker is "osx"; keep both spellings in one place.
export function releaseTarget(rid) {
  const [family, arch] = String(rid ?? "").split("-")
  const platformName = { linux: "linux", win: "win32", osx: "darwin" }[family]
  if (!platformName || !["x64", "arm64"].includes(arch)) return null
  return { rid: `${family}-${arch}`, family, arch, platformName }
}

export function macArtifactNames({ version, arch }) {
  const stem = `${APP_BINARY}-${normalizeVersion(version)}-mac-${arch}`
  return { app: MAC_APP_BUNDLE, dmg: `${stem}.dmg`, zip: `${stem}.zip` }
}

export function buildMacCodesignArgs({ identity, target, entitlements }) {
  return ["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, target]
}

export function buildMacDmgCodesignArgs({ identity, target }) {
  return ["--force", "--timestamp", "--sign", identity, target]
}

export function buildMacDmgArgs({ appPath, outputFile, volumeName = APP_NAME }) {
  return ["create", "-volname", volumeName, "-srcfolder", appPath, "-ov", "-format", "UDZO", outputFile]
}

export function buildMacZipArgs({ appPath, outputFile }) {
  return ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, outputFile]
}

export function macSigningConfig(env = process.env) {
  const identity = String(env?.CODESIGN_IDENTITY ?? "").trim()
  const notarize = String(env?.MAC_NOTARIZE ?? "").trim() === "1"
  if (notarize && !identity) {
    throw new Error(
      "Không thể notarise bản macOS khi chưa đặt CODESIGN_IDENTITY. " +
      "Đặt biến môi trường CODESIGN_IDENTITY (\"Developer ID Application: ...\") rồi chạy lại.",
    )
  }
  return { identity, notarize }
}

export function macNotarizeCredentials(env = process.env) {
  const values = {}
  const missing = []
  for (const [key, name] of Object.entries(MAC_SIGNING_KEYS)) {
    const value = String(env?.[name] ?? "").trim()
    if (value) values[key] = value
    else missing.push(name)
  }
  if (missing.length) {
    throw new Error(
      `Thiếu thông tin xác thực notarisation (${missing.join(", ")}). ` +
      "Đặt biến môi trường APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD và APPLE_TEAM_ID trước khi chạy notarisation.",
    )
  }
  return values
}

export function buildMacNotarytoolArgs({ target, env = process.env }) {
  const { appleId, password, teamId } = macNotarizeCredentials(env)
  return ["notarytool", "submit", "--apple-id", appleId, "--password", password, "--team-id", teamId, "--wait", target]
}

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit", ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${executable} exited with code ${result.status}`)
  }
}

function directorySizeKb(dir) {
  const res = spawnSync("du", ["-sk", dir], { encoding: "utf8" })
  if (res.status === 0 && res.stdout) {
    const num = Number(res.stdout.trim().split(/\s+/)[0])
    if (Number.isFinite(num) && num > 0) return num
  }
  return 0
}

function packageLinux({ version, arch, sourceDir, outDir }) {
  const debArch = arch === "arm64" ? "arm64" : "amd64"
  const rpmArch = arch === "arm64" ? "aarch64" : "x86_64"
  const iconPath = path.join(root, "desktop", "assets", "icon.svg")
  const stageRoot = path.join(root, "release-stage", `linux-${arch}`)
  rmSync(stageRoot, { recursive: true, force: true })

  // 1. Debian / Ubuntu .deb package
  const debRoot = path.join(stageRoot, "deb")
  const debOpt = path.join(debRoot, "opt", PACKAGE_ID)
  mkdirSync(path.join(debRoot, "DEBIAN"), { recursive: true })
  mkdirSync(debOpt, { recursive: true })
  mkdirSync(path.join(debRoot, "usr", "bin"), { recursive: true })
  mkdirSync(path.join(debRoot, "usr", "share", "applications"), { recursive: true })
  mkdirSync(path.join(debRoot, "usr", "share", "icons", "hicolor", "scalable", "apps"), { recursive: true })
  mkdirSync(path.join(debRoot, "usr", "share", "mime", "packages"), { recursive: true })

  cpSync(sourceDir, debOpt, { recursive: true, verbatimSymlinks: true })
  const launcherPath = path.join(debRoot, "usr", "bin", PACKAGE_ID)
  writeFileSync(launcherPath, buildLinuxLauncher(), "utf8")
  chmodSync(launcherPath, 0o755)
  writeFileSync(path.join(debRoot, "usr", "share", "applications", `${PACKAGE_ID}.desktop`), buildDesktopEntry(), "utf8")
  cpSync(iconPath, path.join(debRoot, "usr", "share", "icons", "hicolor", "scalable", "apps", `${PACKAGE_ID}.svg`))
  writeFileSync(path.join(debRoot, "usr", "share", "mime", "packages", `${PACKAGE_ID}.xml`), buildMimeXml(), "utf8")

  const installedSizeKb = directorySizeKb(debOpt)
  writeFileSync(path.join(debRoot, "DEBIAN", "control"), buildDebianControl({ version, arch: debArch, installedSizeKb }), "utf8")
  const postinstPath = path.join(debRoot, "DEBIAN", "postinst")
  const postrmPath = path.join(debRoot, "DEBIAN", "postrm")
  writeFileSync(postinstPath, buildDebianPostinst(), "utf8")
  writeFileSync(postrmPath, buildDebianPostrm(), "utf8")
  chmodSync(postinstPath, 0o755)
  chmodSync(postrmPath, 0o755)

  const debFile = path.join(outDir, `${PACKAGE_ID}_${version}_${debArch}.deb`)
  run("dpkg-deb", ["--root-owner-group", "--build", debRoot, debFile])
  run("dpkg-deb", ["--info", debFile])

  // 2. Fedora / RHEL .rpm package
  const rpmTop = path.join(stageRoot, "rpmbuild")
  for (const sub of ["BUILD", "BUILDROOT", "RPMS", "SOURCES", "SPECS", "SRPMS"]) {
    mkdirSync(path.join(rpmTop, sub), { recursive: true })
  }
  const specPath = path.join(rpmTop, "SPECS", `${PACKAGE_ID}.spec`)
  writeFileSync(specPath, buildRpmSpec({ version, sourceDir, iconPath, arch: rpmArch }), "utf8")
  run("rpmbuild", ["-bb", "--define", `_topdir ${rpmTop}`, specPath])

  const { version: rpmVer, release: rpmRel } = rpmVersionParts(version)
  const builtRpm = path.join(rpmTop, "RPMS", rpmArch, `${PACKAGE_ID}-${rpmVer}-${rpmRel}.${rpmArch}.rpm`)
  const rpmFile = path.join(outDir, `${PACKAGE_ID}-${rpmVer}-${rpmRel}.${rpmArch}.rpm`)
  cpSync(builtRpm, rpmFile)
  run("rpm", ["-qip", rpmFile])

  // 3. Universal portable Linux .tar.gz
  const tarStage = path.join(stageRoot, "tar")
  const tarFolderName = `${PACKAGE_ID}-${version}-linux-${arch}`
  mkdirSync(tarStage, { recursive: true })
  symlinkSync(sourceDir, path.join(tarStage, tarFolderName))
  const tarFile = path.join(outDir, `${tarFolderName}.tar.gz`)
  run("tar", ["-chzf", tarFile, "-C", tarStage, tarFolderName])

  rmSync(stageRoot, { recursive: true, force: true })
  return [debFile, rpmFile, tarFile]
}

function findInnoSetupCompiler() {
  const candidates = [
    process.env.ISCC_PATH,
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
    "ISCC.exe",
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate === "ISCC.exe") {
      const probe = spawnSync("where", ["ISCC.exe"], { encoding: "utf8" })
      if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0]
    } else if (existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

function packageWindows({ version, arch, sourceDir, outDir }) {
  const outputs = []

  // 1. Portable ZIP (Windows 10/11)
  const zipFile = path.join(outDir, `${APP_BINARY}-${version}-win-${arch}-portable.zip`)
  rmSync(zipFile, { force: true })
  const sevenZip = spawnSync("where", ["7z"], { encoding: "utf8" })
  if (sevenZip.status === 0) {
    run("7z", ["a", "-tzip", "-mx=7", zipFile, path.join(sourceDir, "*")])
  } else {
    run("pwsh", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${zipFile}' -Force`,
    ])
  }
  outputs.push(zipFile)

  // 2. Native Windows 10/11 Installer (.exe via Inno Setup 6)
  const iscc = findInnoSetupCompiler()
  if (!iscc) {
    throw new Error("Inno Setup 6 (ISCC.exe) not found. Install via `choco install innosetup`.")
  }
  const stageRoot = path.join(root, "release-stage", `win-${arch}`)
  mkdirSync(stageRoot, { recursive: true })
  const setupBase = `${APP_BINARY}-${version}-win-${arch}-setup`
  const issPath = path.join(stageRoot, `${PACKAGE_ID}.iss`)
  writeFileSync(
    issPath,
    "\uFEFF" + buildInnoSetupScript({ version, sourceDir, outputDir: outDir, outputBaseName: setupBase }),
    "utf8",
  )
  run(iscc, [issPath])
  const exeFile = path.join(outDir, `${setupBase}.exe`)
  if (!existsSync(exeFile)) throw new Error(`Expected installer missing: ${exeFile}`)
  outputs.push(exeFile)
  rmSync(stageRoot, { recursive: true, force: true })
  return outputs
}

function isMachO(filePath) {
  const descriptor = openSync(filePath, "r")
  try {
    const head = Buffer.alloc(4)
    if (readSync(descriptor, head, 0, 4, 0) < 4) return false
    return MACHO_MAGIC.has(head.readUInt32BE(0)) || MACHO_MAGIC.has(head.readUInt32LE(0))
  } finally {
    closeSync(descriptor)
  }
}

// Nested bundles and the bundled .NET worker are sealed into the app, so they are signed first.
function signableTargets(directory) {
  const found = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const child = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...signableTargets(child))
      if (/\.(app|framework|xpc)$/.test(entry.name)) found.push(child)
    } else if (isMachO(child)) {
      found.push(child)
    }
  }
  return found
}

function signMacBundle({ appPath, identity, entitlements, inheritedEntitlements }) {
  for (const target of signableTargets(appPath)) {
    run("codesign", buildMacCodesignArgs({ identity, target, entitlements: inheritedEntitlements }))
  }
  run("codesign", buildMacCodesignArgs({ identity, target: appPath, entitlements }))
}

function packageMac({ version, arch, sourceDir, outDir }) {
  const names = macArtifactNames({ version, arch })
  const appPath = path.join(sourceDir, names.app)
  if (!existsSync(appPath)) {
    throw new Error(`Packaged macOS app not found at ${appPath}. Run \`npm run desktop:package -- osx-${arch}\` first.`)
  }
  const { identity, notarize } = macSigningConfig(process.env)
  const stageRoot = path.join(root, "release-stage", `osx-${arch}`)
  mkdirSync(stageRoot, { recursive: true })
  const entitlements = path.join(stageRoot, "entitlements.mac.plist")
  const inheritedEntitlements = path.join(stageRoot, "entitlements.mac.inherit.plist")
  writeFileSync(entitlements, macEntitlements(), "utf8")
  writeFileSync(inheritedEntitlements, macInheritedEntitlements(), "utf8")

  // Unsigned fallback: without a Developer ID the app still runs locally after an explicit
  // Gatekeeper bypass, and CI keeps publishing the .dmg/.zip for manual verification.
  if (identity) {
    signMacBundle({ appPath, identity, entitlements, inheritedEntitlements })
  } else {
    console.warn("CODESIGN_IDENTITY chưa đặt — bỏ qua bước ký, bản .app/.dmg sẽ không được ký.")
  }

  if (notarize) {
    run("xcrun", buildMacNotarytoolArgs({ target: appPath }))
    run("xcrun", ["stapler", "staple", appPath])
  } else {
    console.warn("MAC_NOTARIZE chưa bật — bỏ qua notarisation, Gatekeeper sẽ cảnh báo khi mở bản tải về.")
  }

  const dmgFile = path.join(outDir, names.dmg)
  const zipFile = path.join(outDir, names.zip)
  rmSync(dmgFile, { force: true })
  rmSync(zipFile, { force: true })
  run("hdiutil", buildMacDmgArgs({ appPath, outputFile: dmgFile }))
  run("ditto", buildMacZipArgs({ appPath, outputFile: zipFile }))
  if (identity) run("codesign", buildMacDmgCodesignArgs({ identity, target: dmgFile }))
  rmSync(stageRoot, { recursive: true, force: true })
  return [dmgFile, zipFile]
}

async function main() {
  const defaultFamily = { win32: "win", darwin: "osx", linux: "linux" }[process.platform] ?? "linux"
  const [rid = `${defaultFamily}-${process.arch}`, rawVersion] = process.argv.slice(2)
  const version = normalizeVersion(rawVersion || process.env.RELEASE_VERSION || pkg.version)
  const target = releaseTarget(rid)
  if (!target) {
    throw new Error("Usage: node scripts/package-release.mjs <linux-x64|win-x64|osx-x64|osx-arm64> [version]")
  }
  const { family, arch, platformName } = target
  const sourceDir = path.join(root, "desktop-dist", `${APP_BINARY}-${platformName}-${arch}`)
  if (!existsSync(sourceDir)) {
    throw new Error(`Packaged desktop app not found at ${sourceDir}. Run \`npm run desktop:package -- ${rid}\` first.`)
  }
  const outDir = path.join(root, "release-dist")
  mkdirSync(outDir, { recursive: true })

  const artifacts = family === "linux"
    ? packageLinux({ version, arch, sourceDir, outDir })
    : family === "win"
      ? packageWindows({ version, arch, sourceDir, outDir })
      : packageMac({ version, arch, sourceDir, outDir })

  for (const file of artifacts) {
    const sizeMb = (statSync(file).size / (1024 * 1024)).toFixed(1)
    const digest = await sha256File(file)
    console.log(`Built ${path.basename(file)} (${sizeMb} MB) sha256=${digest}`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error))
    process.exit(1)
  })
}
