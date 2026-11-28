import SwiftUI

struct TerminalScreen: View {
    let title: String
    @State private var session: TerminalSession
    @State private var fitRequest = 0
    @Environment(\.scenePhase) private var scenePhase
    @Environment(HomeRouter.self) private var router: HomeRouter?

    init(sessionId: String, title: String, api: APIClient, canWrite: Bool) {
        self.title = title
        _session = State(initialValue: TerminalSession(sessionId: sessionId, api: api, canWrite: canWrite))
    }

    var body: some View {
        VStack(spacing: 0) {
            statusBanner
            TerminalHost(session: session, fitRequest: fitRequest)
                .ignoresSafeArea(.container, edges: .bottom)
        }
        .background(Color.black)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        // 终端恒为黑底：导航栏也固定深色，浅色模式下不出现白条压黑屏
        .toolbarBackground(Color.black, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("适配手机尺寸", systemImage: "arrow.up.left.and.arrow.down.right") { fitRequest += 1 }
                        .disabled(!session.isInteractive)
                    Button("重新连接", systemImage: "arrow.clockwise") { session.attach() }
                    if let g = session.ptyGeometry {
                        Text("PTY \(g.cols)×\(g.rows)")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
            }
        }
        .onAppear {
            session.attach()
            router?.immersive += 1
        }
        .task {
            // 调试：`-fitOnOpen YES` 连上后自动「适配手机尺寸」（无界面验证用）
            guard UserDefaults.standard.bool(forKey: "fitOnOpen") else { return }
            while !session.isInteractive { try? await Task.sleep(for: .milliseconds(200)) }
            try? await Task.sleep(for: .milliseconds(500))
            fitRequest += 1
        }
        .onDisappear {
            session.detach()
            if let router { router.immersive = max(0, router.immersive - 1) }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: session.suspend()
            case .active: session.resume()
            default: break
            }
        }
    }

    @ViewBuilder private var statusBanner: some View {
        switch session.phase {
        case .connected where !session.canWrite:
            banner("只读模式：电脑端未允许远程写入", color: .orange)
        case .connected:
            EmptyView()
        case .connecting:
            banner("连接中…", color: .gray)
        case .reconnecting:
            banner("连接中断，正在重试…", color: .orange)
        case .suspended:
            banner("已暂停（后台）", color: .gray)
        case .exited(let code):
            banner("会话已退出\(code.map { "（\($0)）" } ?? "")", color: .secondary)
        case .failed(let message):
            banner(message, color: .red)
        }
    }

    private func banner(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .background(color.opacity(0.25))
            .foregroundStyle(.white)
    }
}
