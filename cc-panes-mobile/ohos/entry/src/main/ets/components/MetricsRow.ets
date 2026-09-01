import { currentTheme, HOME_GRID_OPTIONS, HOME_METRIC_SPAN } from '../common/Theme';
import { Workspace } from '../model/Workspace';

/**
 * 指标条（对齐 Flutter workspace_tab._MetricsRow）：
 * 工作区 / 项目 / 置顶 / 隐藏 四块，GridRow 栅格自适应（统一 Theme.HOME_GRID_OPTIONS）——
 * xs/sm 两行两列（span 2/4）、md 单行四块（2/8）、lg/xl 单行四块（3/12）；
 * 块内数字 18fp/700 主色 + 标签 11fp 次要色，等高 64vp 卡片底、圆角 12、内容居中。
 */
@ComponentV2
export struct MetricsRow {
  @Param workspaces: Workspace[] = [];

  total(): number {
    return this.workspaces.length;
  }

  projectTotal(): number {
    let count: number = 0;
    for (let item of this.workspaces) {
      count += item.projectCount;
    }
    return count;
  }

  pinnedCount(): number {
    let count: number = 0;
    for (let item of this.workspaces) {
      if (item.pinned) {
        count++;
      }
    }
    return count;
  }

  hiddenCount(): number {
    let count: number = 0;
    for (let item of this.workspaces) {
      if (item.hidden) {
        count++;
      }
    }
    return count;
  }

  @Builder
  metricCell(value: string, label: string, color: string) {
    Column({ space: 2 }) {
      Text(value)
        .fontSize(18)
        .fontWeight(700)
        .fontColor(color)
        .maxLines(1)
      Text(label)
        .fontSize(11)
        .fontColor(currentTheme().textSecondary)
        .maxLines(1)
    }
    .width('100%')
    .height(64)
    .justifyContent(FlexAlign.Center)
    .alignItems(HorizontalAlign.Center)
    .borderRadius(12)
    .backgroundColor(currentTheme().card)
    .border({ width: 1, color: currentTheme().divider })
  }

  build() {
    GridRow(HOME_GRID_OPTIONS) {
      GridCol({ span: HOME_METRIC_SPAN }) {
        this.metricCell(`${this.total()}`, '工作区', currentTheme().primary)
      }
      GridCol({ span: HOME_METRIC_SPAN }) {
        this.metricCell(`${this.projectTotal()}`, '项目', currentTheme().primary)
      }
      GridCol({ span: HOME_METRIC_SPAN }) {
        this.metricCell(`${this.pinnedCount()}`, '置顶', currentTheme().primary)
      }
      GridCol({ span: HOME_METRIC_SPAN }) {
        this.metricCell(`${this.hiddenCount()}`, '隐藏', currentTheme().tertiary)
      }
    }
    .width('100%')
  }
}
