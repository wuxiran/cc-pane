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
echo "IOS_BUILD=PASS（未签名构建；真机签名与安装需在 Xcode 配置 Team）"
