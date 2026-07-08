import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:xterm/xterm.dart';

import '../../state/terminal_controller.dart';
import '../widgets/key_bar.dart';

/// 终端页：xterm 渲染 + WS 输入 + 快捷键条。
/// 默认不 resize 共享 PTY（避免破坏桌面端渲染），AppBar 提供手动「适配尺寸」；
/// 手动适配过后，旋转/键盘等 metrics 变化会自动再适配。
class TerminalScreen extends ConsumerStatefulWidget {
  const TerminalScreen({super.key, required this.sessionId, required this.title});

  final String sessionId;
  final String title;

  @override
  ConsumerState<TerminalScreen> createState() => _TerminalScreenState();
}

class _TerminalScreenState extends ConsumerState<TerminalScreen>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeMetrics() {
    ref
        .read(terminalControllerProvider(widget.sessionId))
        .onViewMetricsChanged();
  }

  @override
  Widget build(BuildContext context) {
    final controller = ref.watch(terminalControllerProvider(widget.sessionId));

    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis),
        actions: [
          if (controller.phase == TerminalPhase.connected)
            IconButton(
              icon: const Icon(Icons.fit_screen_outlined),
              tooltip: '把 PTY 尺寸调整为手机屏幕（会影响桌面端同一会话的渲染）',
              onPressed: () {
                controller.resizeToView();
                ScaffoldMessenger.of(context).showSnackBar(
                  const SnackBar(content: Text('已按手机屏幕调整终端尺寸')),
                );
              },
            ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (controller.phase == TerminalPhase.connecting)
              const LinearProgressIndicator(minHeight: 2),
            if (controller.phase == TerminalPhase.error)
              MaterialBanner(
                content: Text(controller.errorMessage ?? '连接中断'),
                actions: [
                  TextButton(
                    onPressed: () => ref.invalidate(
                        terminalControllerProvider(widget.sessionId)),
                    child: const Text('重连'),
                  ),
                ],
              ),
            if (controller.phase == TerminalPhase.exited)
              MaterialBanner(
                content: Text('会话已退出（exit ${controller.exitCode ?? '?'}）'),
                actions: [
                  TextButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: const Text('返回'),
                  ),
                ],
              ),
            Expanded(
              child: ColoredBox(
                color: const Color(0xFF1E1E1E),
                child: TerminalView(
                  controller.terminal,
                  // 打包的 CJK 等宽字体：系统等宽字体普遍缺 CJK，回退字体
                  // 非等宽会让中文与 cell 网格错位。
                  textStyle: const TerminalStyle(
                    fontSize: 12,
                    fontFamily: 'MapleMonoNFCN',
                  ),
                  autofocus: true,
                ),
              ),
            ),
            KeyBar(controller: controller),
          ],
        ),
      ),
    );
  }
}
