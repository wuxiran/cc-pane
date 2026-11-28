import Foundation

/// 快照与实时流的拼接：先连 WS 并缓冲，再取快照，按 `endSeq` 去掉已被快照覆盖的部分。
///
/// 服务端 output 帧带 `endSeq` = 该块最后一个 raw 字节的流内序号（含）。块起点
/// 由 `endSeq - utf8 字节数` 推出。与快照末尾 `snapshotEnd` 比较：
/// - 整块 ≤ snapshotEnd：丢弃（快照已含）
/// - 跨界：裁掉前缀（按 UTF-8 字节，退到字符边界）
/// - 之后：原样写入
/// 不带 `endSeq` 的帧（旧 daemon / emitter 模式）无法判定，快照之前缓冲的一律丢弃
/// （快照在其后读取，必然已含），快照之后的原样写入。
struct OutputSequencer {
    private(set) var snapshotEnd: UInt64?
    private var pending: [OutputFrame] = []

    struct OutputFrame: Equatable {
        var data: String
        var endSeq: UInt64?
    }

    /// 快照到达前：缓冲；之后：返回应写入终端的文本（可能为 nil）。
    mutating func accept(_ frame: OutputFrame) -> String? {
        guard let end = snapshotEnd else {
            pending.append(frame)
            return nil
        }
        let out = Self.trim(frame, after: end, buffered: false)
        if let frameEnd = frame.endSeq { snapshotEnd = max(end, frameEnd) }
        return out
    }

    /// 快照就位：返回缓冲帧中需要补写的部分（按到达顺序拼接）。
    /// `endSeq == nil`（旧版无序号快照）时缓冲帧全部丢弃——快照读取在其后，已含这些输出。
    mutating func snapshotApplied(endSeq: UInt64?) -> String {
        defer { pending.removeAll() }
        guard let endSeq else {
            snapshotEnd = 0
            return ""
        }
        var cursor = endSeq
        var out = ""
        for frame in pending {
            if let piece = Self.trim(frame, after: cursor, buffered: true) { out += piece }
            if let frameEnd = frame.endSeq { cursor = max(cursor, frameEnd) }
        }
        snapshotEnd = cursor
        return out
    }

    mutating func reset() {
        snapshotEnd = nil
        pending.removeAll()
    }

    static func trim(_ frame: OutputFrame, after end: UInt64, buffered: Bool) -> String? {
        guard let frameEnd = frame.endSeq else {
            return buffered ? nil : frame.data
        }
        if frameEnd <= end { return nil }
        let bytes = Array(frame.data.utf8)
        let start = frameEnd >= UInt64(bytes.count) ? frameEnd - UInt64(bytes.count) : 0
        if start >= end { return frame.data }
        var cut = Int(end - start)
        // 退到 UTF-8 字符边界（续字节形如 10xxxxxx）
        while cut < bytes.count, bytes[cut] & 0xC0 == 0x80 { cut += 1 }
        guard cut < bytes.count else { return nil }
        return String(decoding: bytes[cut...], as: UTF8.self)
    }
}
