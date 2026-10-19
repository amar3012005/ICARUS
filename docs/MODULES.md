# ICARUS modules and source ownership

ICARUS is one flagship repository and community entrypoint. Existing paths and package names
remain compatible; this organization does not duplicate private source or claim integrations shipped.

| Module | Authoritative source | Installation / dependency boundary |
| --- | --- | --- |
| Memory | Rust workspace under `crate/`, `crate/mneme-node`, Python bindings in `crate/` | Default local memory; Node, Rust and Python artifacts retain their existing build paths |
| Harness | `crate/icarus-harness` and existing CLI/MCP adapters | Explicit repository opt-in; no model or hosted service required; no adapters certified yet |
| Agent Bus | Private `amar3012005/SINGULANCE-agent-bus` | Unix socket / SQLite mailbox; proposed bridge in AGENT_BUS_INTEGRATION.md is not shipped; no source vendoring or implicit installer |
| Computer Use | Public `amar3012005/HIVEMIND-Computer-use` | Separate Node 22 / E2B evaluation, caller-supplied browser plan; not a general planner or production integration |

Memory is durable context; Bus messages are transient transport. A bus receipt is not a memory
commit or a task completion receipt. Computer actions need their own execution evidence.
Harness governs an opted-in task; it does not replace the native Runtime loop.

Runtime and HyperAgent implementation belongs to `amar3012005/Runtime-Runner`.
HIVEMIND frontend owns browser presentation; its control plane owns identity. Neither is copied
into this public repository. Future module integration must name its source, permissions,
independent installation, failure behavior, tested acceptance and released artifact.

`modules.json` is a descriptive inventory, not an installer or enabled-feature configuration.
Published binaries and npm artifacts must be verified separately from these source paths.

## Local source workspace

Optional source is present under `modules/agent-bus/` and `modules/computer-use/` as independent,
ignored repositories. Run `python3 scripts/modules.py status` for actual local revisions.
See [local setup and module entrypoints](../modules/README.md). This is a concrete local
source arrangement; it does not vendor private code into the flagship or implement runtime bridges.
