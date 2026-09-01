/**
 * 统一错误处理，对齐 Flutter 版 lib/core/result.dart 与后端 AppResult<T> 风格：
 * API/存储层返回 Result 而不是裸 throw 穿层，UI 层显式分支。
 */

/** 失败分类（对齐 Dart FailureKind 枚举值，字符串枚举便于序列化与比较）。 */
export enum FailureKind {
  /** 网络不可达 / 超时 */
  Network = 'network',
  /** 401：会话过期或未登录 */
  Unauthorized = 'unauthorized',
  /** 403 READ_ONLY：远程只读模式拦截 */
  ReadOnly = 'readOnly',
  /** 403 REMOTE_FORBIDDEN：来源被服务端拒绝 */
  RemoteForbidden = 'remoteForbidden',
  /** 404 等其余 HTTP 错误 */
  Http = 'http',
  /** 响应解析失败等本地错误 */
  Local = 'local',
}

export class ApiFailure {
  readonly kind: FailureKind;
  readonly message: string;
  readonly statusCode: number | undefined;

  constructor(kind: FailureKind, message: string, statusCode?: number) {
    this.kind = kind;
    this.message = message;
    this.statusCode = statusCode;
  }

  toString(): string {
    return `ApiFailure(${this.kind}, ${this.statusCode}, ${this.message})`;
  }
}

/** Result<T>：ok=true 时 value 有效；ok=false 时 failure 有效。 */
export class Result<T> {
  readonly ok: boolean;
  readonly value: T | undefined;
  readonly failure: ApiFailure | undefined;

  constructor(ok: boolean, value: T | undefined, failure: ApiFailure | undefined) {
    this.ok = ok;
    this.value = value;
    this.failure = failure;
  }
}

export function Ok<T>(value: T): Result<T> {
  return new Result<T>(true, value, undefined);
}

/** 无值成功（对齐 Dart 的 Ok<void>）。 */
export function OkVoid(): Result<void> {
  return new Result<void>(true, undefined, undefined);
}

export function Err<T>(failure: ApiFailure): Result<T> {
  return new Result<T>(false, undefined, failure);
}
