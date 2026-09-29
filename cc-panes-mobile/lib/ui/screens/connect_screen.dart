import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/config.dart';
import '../../models/server_profile.dart';
import '../../state/auth_controller.dart';
import '../widgets/adaptive_layout.dart';

/// 首次配置 / 登录失败后的连接页。
class ConnectScreen extends ConsumerStatefulWidget {
  const ConnectScreen({super.key, this.initial, this.errorMessage});

  final ServerProfile? initial;
  final String? errorMessage;

  @override
  ConsumerState<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends ConsumerState<ConnectScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _urlController;
  late final TextEditingController _usernameController;
  late final TextEditingController _passwordController;

  @override
  void initState() {
    super.initState();
    _urlController = TextEditingController(text: widget.initial?.baseUrl ?? '');
    _usernameController =
        TextEditingController(text: widget.initial?.username ?? 'admin');
    _passwordController =
        TextEditingController(text: widget.initial?.password ?? '');
  }

  @override
  void dispose() {
    _urlController.dispose();
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    final baseUrl = ServerProfile.normalizeBaseUrl(_urlController.text);
    final profile = ServerProfile(
      id: widget.initial?.id ??
          DateTime.now().millisecondsSinceEpoch.toString(),
      name: Uri.parse(baseUrl).host,
      baseUrl: baseUrl,
      username: _usernameController.text.trim(),
      password: _passwordController.text,
    );
    await ref.read(authControllerProvider.notifier).connectWith(profile);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('连接 CC-Panes')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ContentWidth(
            maxWidth: Breakpoints.formMaxWidth,
            child: Form(
              key: _formKey,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  if (widget.errorMessage != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: Text(
                        widget.errorMessage!,
                        style: TextStyle(
                            color: Theme.of(context).colorScheme.error),
                      ),
                    ),
                  TextFormField(
                    controller: _urlController,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: '服务器地址',
                      hintText:
                          'http://192.168.1.5:${AppConfig.defaultPort} 或 Tailscale 域名',
                      border: OutlineInputBorder(),
                    ),
                    validator: (value) =>
                        (value == null || value.trim().isEmpty)
                            ? '请输入服务器地址'
                            : null,
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _usernameController,
                    autocorrect: false,
                    decoration: const InputDecoration(
                      labelText: '账号',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 16),
                  TextFormField(
                    controller: _passwordController,
                    obscureText: true,
                    decoration: const InputDecoration(
                      labelText: '密码',
                      border: OutlineInputBorder(),
                    ),
                  ),
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: _submit,
                    child: const Padding(
                      padding: EdgeInsets.symmetric(vertical: 12),
                      child: Text('连接'),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Text(
                    '需要桌面端已启动 Web 服务，并开启「账号密码登录」+「允许局域网访问」，'
                    '或通过 Tailscale Serve 访问。',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
