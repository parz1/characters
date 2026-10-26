# @characters/mcp

Thin stdio MCP gateway to an already-running authenticated local management service.
The six tools derive their arguments from @characters/protocol. No management tools,
model credentials, offline database, or agent execution loop are provided.

Explicit management pairing fixes the workspace, service generation, connection and
host session. Calls require matching host transport `_meta.threadId`; strict policy
evidence remains the responsibility of the service-side trusted verifier.

See [gateway guide](../../docs/mcp.md) for pairing, budgets, retries and failure behavior.
