import Foundation

/// 任意 JSON 值。ACP `session/update` 的 params 由服务端原样透传，变体会随协议演进，
/// 所以 payload 不建死类型：按需取字段，未知形状仍可保留与回显。
enum JSONValue: Sendable, Equatable, Hashable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? { if case .string(let s) = self { s } else { nil } }
    var number: Double? { if case .number(let n) = self { n } else { nil } }
    var int: Int? { number.map { Int($0) } }
    var bool: Bool? { if case .bool(let b) = self { b } else { nil } }
    var array: [JSONValue]? { if case .array(let a) = self { a } else { nil } }
    var object: [String: JSONValue]? { if case .object(let o) = self { o } else { nil } }
    var isNull: Bool { self == .null }

    /// 便于测试 / mock 用字面量构造。
    static func from(_ any: Any?) -> JSONValue {
        switch any {
        case nil, is NSNull: return .null
        case let b as Bool: return .bool(b)
        case let i as Int: return .number(Double(i))
        case let d as Double: return .number(d)
        case let s as String: return .string(s)
        case let a as [Any]: return .array(a.map { from($0) })
        case let o as [String: Any]: return .object(o.mapValues { from($0) })
        default: return .null
        }
    }

    /// 紧凑 JSON 文本（工具卡 rawInput 展示 / 调试）。
    var compactText: String {
        guard let data = try? JSONEncoder.sorted.encode(self) else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    /// 解码成具体类型（形状不符返回 nil）。
    func decode<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

extension JSONEncoder {
    static var sorted: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }
}
