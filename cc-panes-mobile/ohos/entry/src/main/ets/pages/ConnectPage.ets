import { ApiFailure, FailureKind } from '../common/Result';
import { currentTheme } from '../common/Theme';
import { ServerProfile } from '../model/ServerProfile';
import { authController } from '../stores/AuthController';

/**
 * 失败文案映射（对齐 Flutter main.dart _Root._describeFailure）：
 * network → 『无法连接服务器：…』；remoteForbidden → 指引开启局域网访问 / Tailscale；
 * unauthorized（含其余）→ 原文透传。
 */
export function describeAuthFailure(failure: ApiFailure | undefined): string {
  if (failure === undefined) {
    return '';
  }
  if (failure.kind === FailureKind.Network) {
    return `无法连接服务器：${failure.message}`;
  }
  if (failure.kind === FailureKind.RemoteForbidden) {
    return '服务端拒绝了远程访问。请在桌面端开启「允许局域网访问」并设置密码，或改用 Tailscale。';
  }
  return failure.message;
}

/** 从 baseUrl 提取 host 作为 profile 显示名（等价 Dart Uri.parse(host)）。 */
function hostOf(url: string): string {
  let rest: string = url;
  let schemeIndex: number = rest.indexOf('://');
  if (schemeIndex >= 0) {
    rest = rest.substring(schemeIndex + 3);
  }
  let end: number = rest.length;
  let slashIndex: number = rest.indexOf('/');
  if (slashIndex >= 0 && slashIndex < end) {
    end = slashIndex;
  }
  let colonIndex: number = rest.indexOf(':');
  if (colonIndex >= 0 && colonIndex < end) {
    end = colonIndex;
  }
  return rest.substring(0, end);
}

/**
 * 连接页（对齐 Flutter connect_screen）：
 * 服务器地址（空校验）/ 账号（预填 admin）/ 密码 → normalizeBaseUrl → connectWith。
 * 登录失败时由 Index 传入 failureText 预填原 profile。
 */
@ComponentV2
export struct ConnectPage {
  @Param failureText: string = '';
  // 本机装机预填的默认服务器（aboutToAppear 会用已保存的 profile 覆盖）
  @Local baseUrl: string = 'http://192.168.3.3:18085';
  @Local username: string = 'admin@163.com';
  @Local password: string = 'admin123';
  @Local urlError: string = '';

  aboutToAppear(): void {
    let profile: ServerProfile | undefined = authController().profile;
    if (profile !== undefined) {
      this.baseUrl = profile.baseUrl;
      this.username = profile.username.length > 0 ? profile.username : 'admin';
      this.password = profile.password;
    }
  }

  async submit(): Promise<void> {
    if (this.baseUrl.trim().length === 0) {
      this.urlError = '请输入服务器地址';
      return;
    }
    this.urlError = '';
    let normalized: string = ServerProfile.normalizeBaseUrl(this.baseUrl);
    let existing: ServerProfile | undefined = authController().profile;
    let profile: ServerProfile = new ServerProfile(
      existing !== undefined && existing.id.length > 0 ? existing.id : `${Date.now()}`,
      hostOf(normalized),
      normalized,
      this.username.trim(),
      this.password
    );
    await authController().connectWith(profile);
  }

  @Builder
  fieldLabel(text: string) {
    Text(text)
      .fontSize(13)
      .fontColor(currentTheme().textSecondary)
      .margin({ bottom: 6 })
  }

  @Builder
  fieldError(text: string) {
    if (text.length > 0) {
      Text(text)
        .fontSize(12)
        .fontColor(currentTheme().error)
        .margin({ top: 4 })
    }
  }

  build() {
    Column() {
      Scroll() {
        Column({ space: 16 }) {
          Text('连接 CC-Panes')
            .fontSize(20)
            .fontWeight(FontWeight.Bold)
            .fontColor(currentTheme().textPrimary)

          if (this.failureText.length > 0) {
            Text(this.failureText)
              .fontSize(13)
              .fontColor(currentTheme().error)
          }

          Column() {
            this.fieldLabel('服务器地址')
            TextInput({ text: this.baseUrl, placeholder: 'http://192.168.1.5:18080 或 Tailscale 域名' })
              .height(44)
              .fontSize(14)
              .fontColor(currentTheme().textPrimary)
              .placeholderColor(currentTheme().textSecondary)
              .backgroundColor(currentTheme().card)
              .borderRadius(10)
              .border({ width: 1, color: this.urlError.length > 0 ? currentTheme().error : currentTheme().divider })
              .padding({ left: 12, right: 12 })
              .onChange((value: string) => {
                this.baseUrl = value;
                if (value.trim().length > 0) {
                  this.urlError = '';
                }
              })
            this.fieldError(this.urlError)
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')

          Column() {
            this.fieldLabel('账号')
            TextInput({ text: this.username })
              .height(44)
              .fontSize(14)
              .fontColor(currentTheme().textPrimary)
              .backgroundColor(currentTheme().card)
              .borderRadius(10)
              .border({ width: 1, color: currentTheme().divider })
              .padding({ left: 12, right: 12 })
              .onChange((value: string) => {
                this.username = value;
              })
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')

          Column() {
            this.fieldLabel('密码')
            TextInput({ text: this.password })
              .height(44)
              .fontSize(14)
              .fontColor(currentTheme().textPrimary)
              .backgroundColor(currentTheme().card)
              .borderRadius(10)
              .border({ width: 1, color: currentTheme().divider })
              .padding({ left: 12, right: 12 })
              .type(InputType.Password)
              .showPasswordIcon(true)
              .onChange((value: string) => {
                this.password = value;
              })
          }
          .alignItems(HorizontalAlign.Start)
          .width('100%')

          Button('连接')
            .width('100%')
            .height(44)
            .fontSize(15)
            .backgroundColor(currentTheme().primary)
            .fontColor(currentTheme().onPrimary)
            .borderRadius(10)
            .margin({ top: 8 })
            .onClick(() => {
              this.submit();
            })

          Text('需要桌面端已启动 Web 服务，并开启「账号密码登录」+「允许局域网访问」，或通过 Tailscale Serve 访问。')
            .fontSize(12)
            .fontColor(currentTheme().textSecondary)
            .margin({ top: 4 })
        }
        .alignItems(HorizontalAlign.Start)
        .width('100%')
        .constraintSize({ maxWidth: 560, minHeight: '100%' })
        .padding(24)
      }
      .scrollable(ScrollDirection.Vertical)
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(currentTheme().background)
  }
}
