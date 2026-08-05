# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/amar3012005/ICARUS/security/advisories/new)
on this repository. Include a description, affected version/commit, and a reproduction if
you have one. You'll get an acknowledgement, and we'll tell you our assessment and a fix
timeline once we've reproduced it.

**Never include a real `.amr` shard or its contents in a report.** A shard holds a
tenant's memories. Send the 202-byte header, slot ids, and the error instead.

## What mneme does and does not protect

Being precise here matters more than sounding strong.

### Integrity + authenticity (what the signing layer gives you)

Records can be signed with **ML-DSA-65 (NIST FIPS 204)**, a post-quantum lattice
signature. The property is *tamper-evidence and authorship*: an attacker who can write to
the database cannot forge a record that verifies, because the signing key is never in the
database.

- Keys live in server environment only — **database compromise is not signature forgery**.
- Public keys and verification are exposed, so an auditor needs zero trust in the operator.

### Known limitation: signing is fail-open

If signing keys are absent, a write **proceeds unsigned** rather than failing. That is a
deliberate availability choice, and it means *the presence of a shard does not by itself
prove every record in it was signed*. Verify signatures explicitly if you depend on them.
An enforce mode (reject unsigned writes) is on the roadmap — see `ROADMAP.md`.

### NOT provided

- **Encryption at rest.** `.amr` is not encrypted. A reader with filesystem access reads
  the records. Use full-disk/volume encryption and filesystem permissions. Shard files are
  created `0600` in a `0700` directory by the reference maintenance tooling; if you copy
  or back up shards yourself, preserve that.
- **Access control.** The format has no notion of users or roles. Tenant isolation is
  *one shard per tenant* — enforced by whatever opens the file, not by the file.
- **Multi-writer safety across processes.** A shard takes a per-open lock. Two processes
  opening the same shard is a bug in the caller, not something the format arbitrates.

## Supported versions

Pre-1.0. Fixes land on `main`; there are no backported release branches yet. Pin a commit
or a published `singulance-amr` version, and read `CHANGELOG.md` before upgrading.

## Handling shard data

- A `.amr` file is tenant data. Treat backups with the same controls as a database dump.
- Deleted records are **tombstoned, not erased**, until `compact()` reclaims the bytes. If
  you must guarantee erasure (e.g. a GDPR request), run compaction afterwards and make
  sure any snapshot taken before it is expired too.
