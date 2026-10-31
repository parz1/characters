# @characters/reference-host

Disposable local reference client for testing characters with DeepSeek. It is not
the management service, a general agent framework, or the future dsh plugin.
Removing it does not change character or memory formats.

The runtime receives only a scoped agent RPC callback. It has no workspace
filesystem, administrator credential, package loader, or memory store. All
context, retrieval, proposals and binding lifecycle operations use public RPC.
The pinned OpenAI SDK is used exclusively as the DeepSeek-compatible transport,
with an explicit DeepSeek key and endpoint; no OpenAI key fallback is used.

See [reference client guide](../../docs/reference-host.md).
