# ICARUS Harness threat model

## Security boundary

ICARUS is a local deterministic harness. It does not call an LLM, transmit a repository, or
silently approve an external action. The coding agent remains an untrusted executor: its prose,
plans, and claimed test results are not evidence.

## Threats and controls

| Threat | Control | Residual risk |
|---|---|---|
| Malicious repository instructions or prompt injection | Immutable task contract, mandatory policy context, path-scoped write authorization, and evidence from executed checks only | An adapter without pre-action interception is compatibility mode, not certified enforcement |
| Scope escape, path traversal, or nested checkout crossing | Rust canonical-root checks, relative-path rejection, glob-scoped contracts, nested Git/submodule write refusal, and seal-time changed-file validation | Tools invoked outside ICARUS cannot be prevented by compatibility adapters |
| Forged or stale verification | Rust executes contract-defined commands, stores complete output/digests, binds receipts to contract/Git/dirty state, and rejects stale receipts at seal | Local host compromise can alter all local state; signing/remote attestation is future work |
| Forged runtime history | Append-only hash-chained event log with durable head verification | The local machine remains the trust root until optional signing is enabled |
| Poisoned or stale graph context | Graph build receipt binds source fingerprint and database digest; Rust refuses a current graph claim after source changes | Parser coverage is limited to supported languages |
| Compromised or prompt-injected skill | Persona files are excluded; only active verified harness skills enter context; proposed skills require sealed provenance and promotion evidence | Static secret scan is deliberately conservative and not a full DLP system |
| Credential leakage | Runtime is ignored by Git; harness skills reject common secret markers; ICARUS never uploads transcripts/embeddings implicitly | Users must still avoid placing secrets in tracked repository files |
| Cross-tenant organizational data | Local context is default; HIVE-MIND sync is opt-in and must bind org/repo/project/task identities | Optional sync is not yet certified for production use |
| Supply-chain/release substitution | Public source, checksums, signed assets, provenance, and updater verification are required before a production release | These release controls are an outstanding release-candidate gate |

## Non-goals and safe defaults

- A passing health check never substitutes for a task acceptance criterion.
- An agent cannot turn an unverified persona into an execution skill.
- A missing approval remains pending; it never becomes an implicit local approval.
- Cursor and generic MCP clients must be presented as compatibility mode until they pass the
  adapter certification contract.

## Disclosure

Please report security issues privately to the maintainers rather than opening a public issue
with a working exploit. The public security contact and coordinated-disclosure process are a
release-candidate requirement.
