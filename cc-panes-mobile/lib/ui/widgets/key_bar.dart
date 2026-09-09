import 'package:flutter/material.dart';

import '../../state/terminal_controller.dart';

/// 终端快捷键条：软键盘打不出的键（Esc/Tab/Ctrl/方向键/Ctrl+C）。
/// Ctrl 是粘滞键：点亮后下一个字母转 ctrl-code。Enter 发 \r。
class KeyBar extends StatelessWidget {
  const KeyBar({super.key, required this.controller});

  final TerminalSessionController controller;

  @override
  Widget build(BuildContext context) {
    final keys = <(String, VoidCallback)>[
      ('Esc', () => controller.sendSequence('\x1b')),
      ('Tab', () => controller.sendSequence('\t')),
      ('^C', () => controller.sendSequence('\x03')),
      ('↑', () => controller.sendSequence('\x1b[A')),
      ('↓', () => controller.sendSequence('\x1b[B')),
      ('←', () => controller.sendSequence('\x1b[D')),
      ('→', () => controller.sendSequence('\x1b[C')),
      ('Enter', () => controller.sendSequence('\r')),
      ('/', () => controller.sendSequence('/')),
      ('~', () => controller.sendSequence('~')),
    ];

    return IgnorePointer(
      ignoring: !controller.canWrite,
      child: Opacity(
        opacity: controller.canWrite ? 1 : 0.45,
        child: Container(
          height: 48,
          color: Theme.of(context).colorScheme.surfaceContainerHigh,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 4),
            children: [
              _KeyButton(
                label: 'Ctrl',
                highlighted: controller.ctrlLatched,
                onTap: controller.toggleCtrl,
              ),
              for (final (label, onTap) in keys)
                _KeyButton(label: label, onTap: onTap),
            ],
          ),
        ),
      ),
    );
  }
}

class _KeyButton extends StatelessWidget {
  const _KeyButton(
      {required this.label, required this.onTap, this.highlighted = false});

  final String label;
  final VoidCallback onTap;
  final bool highlighted;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 5),
      child: Material(
        color: highlighted ? scheme.primary : scheme.surface,
        borderRadius: BorderRadius.circular(6),
        child: InkWell(
          borderRadius: BorderRadius.circular(6),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Center(
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  fontFamily: 'monospace',
                  color: highlighted ? scheme.onPrimary : scheme.onSurface,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
