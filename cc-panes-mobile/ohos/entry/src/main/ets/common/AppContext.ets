import { common } from '@kit.AbilityKit';

/**
 * UIAbility context holder：EntryAbility.onCreate 里赋值，
 * 供 preferences / asset 等需要 Context 的基础设施在非组件层使用。
 */
export class AppContext {
  static holder: common.UIAbilityContext | undefined = undefined;
}
