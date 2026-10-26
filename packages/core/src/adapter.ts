import type {
  AdapterCapabilities,
  AdapterEvent,
  ExecutionRequest,
} from './schemas.js'

export type ToolGatewayResult =
  | { ok: true; text: string; digest: string }
  | { ok: false; code: string; message: string }
export interface ToolGateway {
  readSource(request: {
    runId: string
    requestId: string
    sourceId: string
  }): Promise<ToolGatewayResult>
}
export interface CharacterAdapter {
  diagnostics?(): unknown
  probe(): Promise<AdapterCapabilities>
  run(
    request: ExecutionRequest,
    tools: ToolGateway,
    signal: AbortSignal,
  ): AsyncIterable<AdapterEvent>
}
