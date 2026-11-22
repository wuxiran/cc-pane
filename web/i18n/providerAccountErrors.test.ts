// 供应商账号（第 1 期前两批）后端新增的错误码都要有中英文案，否则界面只能显示后端的英文原句。
import { describe, expect, it } from "vitest";

import en from "./locales/en/errors.json";
import zh from "./locales/zh-CN/errors.json";

const PROVIDER_ACCOUNT_ERROR_CODES = [
  "PROVIDER_ACCOUNT_NOT_FOUND",
  "PROVIDER_ACCOUNT_NAME_EXISTS",
  "PROVIDER_ACCOUNT_NAME_INVALID",
  "PROVIDER_ACCOUNT_ID_EXISTS",
  "PROVIDER_ACCOUNT_LAST",
  "PROVIDER_ACCOUNT_INCOMPATIBLE",
  "PROVIDER_ACCOUNT_NOT_LOGIN",
  "PROVIDER_LOGIN_ACCOUNT_LOCAL_ONLY",
  "PROVIDER_SECRET_UNAVAILABLE",
  "PROVIDER_SECRETS_UNAVAILABLE",
  "INVALID_PROVIDER_SECRETS",
  "DAEMON_PROVIDER_ACCOUNTS_UNSUPPORTED",
  "LOGIN_ACCOUNT_CLI_UNSUPPORTED",
  "LOGIN_ACCOUNT_CLI_INCOMPATIBLE",
  "LOGIN_ACCOUNT_DEFAULT_UNDELETABLE",
  "LOGIN_ACCOUNT_DIR_UNAVAILABLE",
] as const;

describe("provider account error copy", () => {
  it.each(PROVIDER_ACCOUNT_ERROR_CODES)("%s 有中英文案", (code) => {
    expect((zh as Record<string, string>)[code]?.trim()).toBeTruthy();
    expect((en as Record<string, string>)[code]?.trim()).toBeTruthy();
  });

  it("两种语言用到的插值参数一致", () => {
    const params = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
    for (const code of PROVIDER_ACCOUNT_ERROR_CODES) {
      expect(params((zh as Record<string, string>)[code]), code).toEqual(
        params((en as Record<string, string>)[code]),
      );
    }
  });
});
