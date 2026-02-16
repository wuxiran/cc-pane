//! Action 模型 - 用户/系统触发的动作

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum Action {
    /// 向 PTY 发送原始字节
    SendBytes(Vec<u8>),
    /// 调整 PTY 终端大小
    ResizePty(u16, u16),
    /// 退出应用
    Quit,
    /// 无操作
    None,
    /// 显示项目上下文菜单
    ShowProjectMenu(usize, u16, u16),
    /// 隐藏上下文菜单
    HideMenu,
    /// 在文件管理器中打开项目路径
    OpenProjectPath(usize),
    /// 复制项目完整路径
    CopyFullPath(usize),
    /// 复制项目相对路径
    CopyRelativePath(usize),
}
