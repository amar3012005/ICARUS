# Sealed task export

```sh
icarus task export TASK-… --repo /path/to/repository
icarus task export TASK-… --redact --repo /path/to/repository
```

ICARUS exports a structured receipt only after the task is `sealed`. It never exports the whole
`.icarus/runtime` directory: that directory may contain command output, checkpoints, paths,
adapter configuration, and agent-supplied prose that are inappropriate for a pull request or
external review.

The normal export contains the sealed task objective, Git and dirty-state fingerprints, final
diff digest, final-receipt path, and each verification receipt's id, type, status, digest,
artifacts, output excerpt, and attestation data.

`--redact` retains only the task/execution identifiers, sealed status, Git and dirty-state
fingerprints, final diff digest, and for each criterion its type, status, output digest, and
expiry. It removes the objective, final-receipt path, criterion IDs, artifact paths, output
excerpts, and attestations. Digests make a redacted export useful for comparison without claiming
that it is anonymous or safe for every threat model.

An unsealed task, a missing final receipt, or a malformed final receipt is rejected. Exporting a
receipt is read-only; it does not modify the event chain or copy private data into a new runtime
file.
