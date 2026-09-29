#!/usr/bin/env bash
set -euo pipefail

mobile_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$mobile_root"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS 构建检查需在安装了 Xcode 的 Mac 上运行。" >&2
  exit 2
fi

command -v flutter >/dev/null || { echo "请先安装 Flutter 并加入 PATH。" >&2; exit 2; }
command -v xcodebuild >/dev/null || { echo "请先安装并打开 Xcode，完成 iOS 组件安装。" >&2; exit 2; }
command -v pod >/dev/null || { echo "当前 Keychain 插件仍需 CocoaPods，请先安装。" >&2; exit 2; }

flutter --version
xcodebuild -version
flutter pub get
flutter analyze
flutter test
flutter build ios --debug --no-codesign
# 模拟器切片单独构建一次：Apple Silicon 模拟器是 arm64，与真机构建不是同一产物。
flutter build ios --debug --simulator
echo "IOS_BUILD=PASS（真机未签名构建 + 模拟器构建；真机签名与安装需在 Xcode 配置 Team）"
echo "下一步：open -a Simulator，选 iPhone 与 iPad 各一台后执行 flutter run -d <设备>"
