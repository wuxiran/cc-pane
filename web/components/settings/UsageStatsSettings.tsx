// 设置页「使用统计」分区：只给共享的 HomeUsageStats 套上 page → section 版式，
// 不改它的内部样式（主页侧仍直接渲染 HomeUsageStats）。
// recharts 随 HomeUsageStats 静态进入本模块，懒加载边界由 SettingsPaneContent 对本文件的动态 import 承担。
import HomeUsageStats from "@/components/home/HomeUsageStats";
import { SettingsBlock, SettingsSection } from "./layout";

export default function UsageStatsSettings() {
  return (
    <SettingsSection sectionId="usage-stats-overview">
      <SettingsBlock>
        <HomeUsageStats />
      </SettingsBlock>
    </SettingsSection>
  );
}
