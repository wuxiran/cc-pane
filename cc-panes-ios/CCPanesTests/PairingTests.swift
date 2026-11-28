import XCTest
@testable import CCPanes

final class PairingTests: XCTestCase {
    private let base = URL(string: "http://192.168.1.10:18080")!

    func testPairRequestShape() throws {
        let request = try DevicePairing.pairRequest(baseURL: base, code: " 012 345 ", deviceName: "吴的 iPhone")
        XCTAssertEqual(request.url?.absoluteString, "http://192.168.1.10:18080/api/device/pair")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "配对是免鉴权路由")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String])
        XCTAssertEqual(body, ["code": "012345", "name": "吴的 iPhone"])
    }

    func testEmptyDeviceNameFallsBack() throws {
        let request = try DevicePairing.pairRequest(baseURL: base, code: "123456", deviceName: "  ")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String])
        XCTAssertEqual(body["name"], "iPhone")
    }

    func testInvalidCodesRejectedBeforeNetwork() {
        for code in ["12345", "1234567", "12a456", "１２３４５６", ""] {
            XCTAssertThrowsError(try DevicePairing.pairRequest(baseURL: base, code: code, deviceName: "x")) {
                XCTAssertEqual($0 as? PairingError, .invalidCode, code)
            }
        }
        XCTAssertEqual(DevicePairing.normalizeCode("123-456"), "123456")
    }

    func testParseSuccessAndErrors() throws {
        let ok = try DevicePairing.parse(status: 200, data: Data(#"{"token":"ccp_dev_abc","hostname":"mac-mini","appVersion":"0.13.5"}"#.utf8))
        XCTAssertEqual(ok, PairResult(token: "ccp_dev_abc", hostname: "mac-mini", appVersion: "0.13.5"))
        XCTAssertThrowsError(try DevicePairing.parse(status: 200, data: Data(#"{"token":""}"#.utf8)))
        XCTAssertThrowsError(try DevicePairing.parse(status: 401, data: Data())) { XCTAssertEqual($0 as? PairingError, .rejected) }
        XCTAssertThrowsError(try DevicePairing.parse(status: 403, data: Data("This computer does not accept device connections".utf8))) {
            XCTAssertEqual($0 as? PairingError, .notAccepting)
        }
        XCTAssertThrowsError(try DevicePairing.parse(status: 403, data: Data("Remote access is not allowed".utf8))) {
            guard case .remoteForbidden = $0 as? PairingError else { return XCTFail("\($0)") }
        }
        XCTAssertThrowsError(try DevicePairing.parse(status: 503, data: Data())) { XCTAssertEqual($0 as? PairingError, .unavailable) }
    }

    func testDeviceInfoDecodes() throws {
        let json = #"{"hostname":"mac-mini","os":"macos","osVersion":"15","arch":"aarch64","appVersion":"0.13.5","uptimeSecs":12,"homeDir":"/Users/x","defaultCwd":"/Users/x","headless":false}"#
        let info = try JSONDecoder().decode(DeviceInfo.self, from: Data(json.utf8))
        XCTAssertEqual(info.hostname, "mac-mini")
        XCTAssertEqual(info.headless, false)
    }
}

/// 鉴权注入：REST Bearer、WS `?token=`、401 → 令牌失效回调。
final class APIClientAuthTests: XCTestCase {
    private let base = URL(string: "http://192.168.1.10:18080")!

    func testTokenGoesToBearerAndWebSocketQuery() {
        let api = APIClient(baseURL: base, token: "ccp_dev_xyz")
        var request = URLRequest(url: base)
        api.authorize(&request)
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer ccp_dev_xyz")

        let ws = api.terminalSocketRequest(sessionId: "s-1")
        XCTAssertEqual(ws.url?.absoluteString, "ws://192.168.1.10:18080/ws/s-1?token=ccp_dev_xyz")
        XCTAssertNil(ws.value(forHTTPHeaderField: "Cookie"))

        let acp = AcpClient(api: api).socketRequest(chatId: "mobile-1", afterSeq: 42)
        XCTAssertEqual(acp.url?.absoluteString, "ws://192.168.1.10:18080/ws/acp/mobile-1?afterSeq=42&token=ccp_dev_xyz")
    }

    func testNoTokenMeansNoAuthHeaderAndNoQuery() {
        let api = APIClient(baseURL: URL(string: "https://box.tail.ts.net")!)
        var request = URLRequest(url: api.baseURL)
        api.authorize(&request)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(api.terminalSocketRequest(sessionId: "s").url?.absoluteString, "wss://box.tail.ts.net/ws/s")
    }

    func testUnauthorizedWithTokenNotifies() {
        let fired = expectation(description: "token rejected")
        let api = APIClient(baseURL: base, token: "ccp_dev_xyz") { fired.fulfill() }
        XCTAssertEqual(api.unauthorizedError().localizedDescription, "令牌失效，请重新配对")
        wait(for: [fired], timeout: 1)
        XCTAssertEqual(APIClient(baseURL: base).unauthorizedError().localizedDescription, "会话已过期，请重新登录")
    }
}
