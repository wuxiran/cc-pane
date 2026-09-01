import { currentTheme } from '../common/Theme';
import { MirrorGroup, MirrorGroupKind } from '../model/MirrorState';

const EMPTY_GROUP: MirrorGroup = new MirrorGroup(MirrorGroupKind.Layout, '', [], undefined, false);

/**
 * 镜像分组头（对齐 Flutter mirror_home_screen._GroupHeader）：
 * 图标 + 组名（当前布局追加『 · 当前』）+ 卡片数。
 * 栅格化后置于 GridRow 外独立成行（跨满内容宽），圆角 10 的 headerBg 条。
 */
@ComponentV2
export struct GroupHeader {
  @Param group: MirrorGroup = EMPTY_GROUP;

  glyph(): string {
    if (this.group.kind === MirrorGroupKind.MobileRemote) {
      return '📱';
    }
    if (this.group.kind === MirrorGroupKind.Orphan) {
      return '?';
    }
    return '▦';
  }

  title(): string {
    if (this.group.kind === MirrorGroupKind.Layout && this.group.isCurrentLayout) {
      return `${this.group.title} · 当前`;
    }
    return this.group.title;
  }

  build() {
    Row({ space: 8 }) {
      Text(this.glyph())
        .fontSize(15)
        .fontColor(currentTheme().textSecondary)
      Text(this.title())
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor(currentTheme().textSecondary)
        .layoutWeight(1)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      Text(`${this.group.cards.length}`)
        .fontSize(12)
        .fontColor(currentTheme().textSecondary)
    }
    .width('100%')
    .alignItems(VerticalAlign.Center)
    .padding({ left: 12, right: 12, top: 8, bottom: 8 })
    .borderRadius(10)
    .backgroundColor(currentTheme().headerBg)
  }
}
