export interface ProjectCliHookStatus {
  name: string;
  label: string;
  enabled: boolean;
  supported: boolean;
  reason: string | null;
}

export interface ProjectCliHookGroupStatus {
  cliTool: string;
  label: string;
  supported: boolean;
  reason: string | null;
  hooks: ProjectCliHookStatus[];
}
