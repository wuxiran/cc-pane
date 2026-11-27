import Foundation

/// ACP `elicitation/create` 表单（mode=form + requestedSchema）的移动端子集。
/// 与桌面 questionSchema.ts 同口径：只有声明的 properties 成为控件；
/// 看不懂的字段标 unsupported，此时只允许「跳过 / 取消」，不替用户乱答。
struct QuestionForm: Sendable, Equatable {
    struct Choice: Sendable, Equatable, Hashable {
        var value: String
        var title: String
        var description: String?
    }

    struct Field: Sendable, Equatable, Identifiable {
        enum FieldType: String, Sendable { case string, number, integer, boolean, array }
        var id: String
        var title: String
        var description: String?
        var type: FieldType
        var required: Bool
        var choices: [Choice]
        var defaultValue: JSONValue?
    }

    var fields: [Field]
    var unsupported: Bool

    static func parse(mode: String?, schema: JSONValue?) -> QuestionForm {
        guard mode == "form", let schema, let props = schema["properties"]?.object else {
            return QuestionForm(fields: [], unsupported: true)
        }
        let required = Set((schema["required"]?.array ?? []).compactMap(\.string))
        var unsupported = false
        // JSON object 无序；按 key 排序得到稳定顺序（schema 未声明顺序）。
        let fields: [Field] = props.keys.sorted().compactMap { key in
            guard let field = parseField(id: key, schema: props[key]!, required: required.contains(key)) else {
                unsupported = true
                return nil
            }
            return field
        }
        return QuestionForm(fields: fields, unsupported: unsupported)
    }

    private static func parseField(id: String, schema: JSONValue, required: Bool) -> Field? {
        guard let typeRaw = schema["type"]?.string, let type = Field.FieldType(rawValue: typeRaw) else { return nil }
        let source = type == .array ? (schema["items"] ?? .null) : schema
        let choices = parseChoices(source)
        if type == .array, choices.isEmpty { return nil }
        return Field(id: id, title: schema["title"]?.string ?? id, description: schema["description"]?.string,
                     type: type, required: required, choices: choices, defaultValue: schema["default"])
    }

    private static func parseChoices(_ schema: JSONValue) -> [Choice] {
        if let variants = (schema["oneOf"] ?? schema["anyOf"])?.array {
            return variants.compactMap { v in
                guard let value = v["const"]?.string else { return nil }
                return Choice(value: value, title: v["title"]?.string ?? value, description: v["description"]?.string)
            }
        }
        return (schema["enum"]?.array ?? []).compactMap(\.string).map { Choice(value: $0, title: $0) }
    }

    /// 草稿 → 提交内容；必填缺失或数字非法时返回 nil（提交按钮置灰）。
    func content(from draft: [String: JSONValue]) -> [String: JSONValue]? {
        var out: [String: JSONValue] = [:]
        for field in fields {
            let value = draft[field.id] ?? field.defaultValue
            guard let value, !Self.isEmpty(value) else {
                if field.required { return nil }
                continue
            }
            switch field.type {
            case .number, .integer:
                guard let text = value.string ?? value.number.map({ String($0) }), let n = Double(text) else { return nil }
                if field.type == .integer, n.rounded() != n { return nil }
                out[field.id] = .number(n)
            default:
                out[field.id] = value
            }
        }
        return out
    }

    private static func isEmpty(_ value: JSONValue) -> Bool {
        switch value {
        case .null: true
        case .string(let s): s.trimmingCharacters(in: .whitespaces).isEmpty
        case .array(let a): a.isEmpty
        default: false
        }
    }
}
