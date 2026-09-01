import { TerminalSessionController } from '../stores/TerminalController';

/** KeyBar 背景（Flutter surfaceContainerHigh 的暗色近似值）。 */
const KEY_BAR_BG: string = '#2D2D2D';
/** 普通键底色（Flutter surface 的暗色近似值）。 */
const KEY_BG: string = '#383838';
/** Ctrl 粘滞点亮底色（Flutter colorScheme.primary，teal；后续统一进 common/Theme.ets）。 */
const KEY_BG_LATCHED: string = '#009688';
const KEY_FG: string = '#EAEAEA';
const KEY_FG_LATCHED: string = '#FFFFFF';

/** 快捷键定义：label 显示、sequence 直发原始 VT 序列（1:1 照抄 Flutter key_bar.dart）。 */
interface KeyDef {
  label: string;
  sequence: string;
}

const KEY_DEFS: KeyDef[] = [
  { label: 'Esc', sequence: '\u001b' },
  { label: 'Tab', sequence: '\t' },
  { label: '^C', sequence: '\u0003' },
  { label: '↑', sequence: '\u001b[A' },
  { label: '↓', sequence: '\u001b[B' },
  { label: '←', sequence: '\u001b[D' },
  { label: '→', sequence: '\u001b[C' },
  { label: 'Enter', sequence: '\r' },
  { label: '/', sequence: '/' },
  { label: '~', sequence: '~' }
];

/**
 * 终端快捷键条：软键盘打不出的键（Esc/Tab/Ctrl/方向键/Ctrl+C）。
 * Ctrl 是粘滞键：点亮后下一个字母输入转 ctrl-code（转换在 controller.handleInput 内完成）。
 * Enter 发 \r（CC-Panes PTY 约定）。
 */
@ComponentV2
export struct KeyBar {
  @Param @Require controller: TerminalSessionController;

  build() {
    Scroll() {
      Row() {
        Text('Ctrl')
          .fontSize(13)
          .fontFamily('monospace')
          .fontColor(this.controller.ctrlLatched ? KEY_FG_LATCHED : KEY_FG)
          .height(30)
          .padding({ left: 12, right: 12 })
          .borderRadius(6)
          .backgroundColor(this.controller.ctrlLatched ? KEY_BG_LATCHED : KEY_BG)
          .margin({ left: 2, right: 2 })
          .onClick((): void => {
            this.controller.toggleCtrl();
          })
        ForEach(KEY_DEFS, (key: KeyDef) => {
          Text(key.label)
            .fontSize(13)
            .fontFamily('monospace')
            .fontColor(KEY_FG)
            .height(30)
            .padding({ left: 12, right: 12 })
            .borderRadius(6)
            .backgroundColor(KEY_BG)
            .margin({ left: 2, right: 2 })
            .onClick((): void => {
              this.controller.sendSequence(key.sequence);
            })
        }, (key: KeyDef) => key.label)
      }
      .height(40)
      .padding({ left: 4, right: 4 })
      .alignItems(VerticalAlign.Center)
    }
    .scrollable(ScrollDirection.Horizontal)
    .scrollBar(BarState.Off)
    .width('100%')
    .height(40)
    .backgroundColor(KEY_BAR_BG)
    .align(Alignment.Center)
  }
}
