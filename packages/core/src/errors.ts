import type { ErrorCode } from './schemas.js'

export class CharactersError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly nextStep: string,
  ) {
    super(message)
    this.name = 'CharactersError'
  }
}

export interface ErrorInfo {
  code: ErrorCode
  message: string
  nextStep: string
}
export type Result<T> =
  | { ok: true; data: T; error: null }
  | { ok: false; data: null; error: ErrorInfo }

export function failure(error: unknown): Result<never> {
  if (error instanceof CharactersError) {
    return {
      ok: false,
      data: null,
      error: {
        code: error.code,
        message: error.message,
        nextStep: error.nextStep,
      },
    }
  }
  // Never expose raw host errors: they can contain credentials or source contents.
  return {
    ok: false,
    data: null,
    error: {
      code: 'STORE_CORRUPT',
      message: '操作失败，未输出底层私人数据。',
      nextStep: '检查目录权限和数据完整性后重试。',
    },
  }
}

export function exitCode(code: ErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 2
    case 'NOT_FOUND':
      return 3
    case 'CONFLICT':
    case 'BUSY':
      return 4
    case 'ISOLATION_UNSUPPORTED':
    case 'PERMISSION_DENIED':
    case 'BINDING_INACTIVE':
    case 'EVIDENCE_EXPIRED':
      return 5
    case 'CONTEXT_LIMIT':
    case 'ADAPTER_PROTOCOL':
    case 'ADAPTER_FAILED':
    case 'ADAPTER_TIMEOUT':
    case 'PROTOCOL_UNSUPPORTED':
    case 'SERVICE_UNAVAILABLE':
      return 6
    case 'STORE_CORRUPT':
    case 'RECOVERY_REQUIRED':
      return 7
    case 'CANCELLED':
      return 130
  }
}
