import AppKit
// 用法：swift scripts/render-app-icon.swift CCPanes/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png
// 从 web/assets/logo.svg 等价重绘：iOS 图标需方形满版、无透明，圆角交给系统蒙版。
let out = CommandLine.arguments[1]
let size = 1024, k = CGFloat(size) / 512
let cs = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.translateBy(x: 0, y: CGFloat(size)); ctx.scaleBy(x: k, y: -k) // SVG 坐标系
func rgb(_ h: UInt32) -> CGColor { CGColor(srgbRed: CGFloat(h >> 16 & 255)/255, green: CGFloat(h >> 8 & 255)/255, blue: CGFloat(h & 255)/255, alpha: 1) }
ctx.setFillColor(rgb(0x17181B)); ctx.fill(CGRect(x: 0, y: 0, width: 512, height: 512))
ctx.setLineCap(.round); ctx.setLineJoin(.round)
func bracket(_ x0: CGFloat, _ x1: CGFloat, _ xc: CGFloat, _ color: UInt32) {
    // M x0 120 L x1 120 C (x1∓24) 120 xc 136 xc 160 L xc 352 C xc 376 (x1∓24) 392 x1 392 L x0 392
    let d: CGFloat = x1 < x0 ? -24 : 24
    let p = CGMutablePath()
    p.move(to: CGPoint(x: x0, y: 120)); p.addLine(to: CGPoint(x: x1, y: 120))
    p.addCurve(to: CGPoint(x: xc, y: 160), control1: CGPoint(x: x1 + d, y: 120), control2: CGPoint(x: xc, y: 136))
    p.addLine(to: CGPoint(x: xc, y: 352))
    p.addCurve(to: CGPoint(x: x1, y: 392), control1: CGPoint(x: xc, y: 376), control2: CGPoint(x: x1 + d, y: 392))
    p.addLine(to: CGPoint(x: x0, y: 392))
    ctx.addPath(p); ctx.setStrokeColor(rgb(color)); ctx.setLineWidth(32); ctx.strokePath()
}
bracket(168, 116, 76, 0x00E5FF)
bracket(344, 396, 436, 0xFF6D00)
ctx.setStrokeColor(rgb(0xFFFFFF)); ctx.setLineWidth(30)
ctx.move(to: CGPoint(x: 210, y: 196)); ctx.addLine(to: CGPoint(x: 268, y: 256)); ctx.addLine(to: CGPoint(x: 210, y: 316)); ctx.strokePath()
ctx.move(to: CGPoint(x: 286, y: 316)); ctx.addLine(to: CGPoint(x: 330, y: 316)); ctx.strokePath()
let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
