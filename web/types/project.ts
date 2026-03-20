/**
 * 项目数据模型
 */
export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  alias?: string;
}

/**
 * 创建项目请求参数
 */
export interface CreateProjectRequest {
  path: string;
}
