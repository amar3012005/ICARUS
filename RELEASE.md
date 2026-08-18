# Releasing mneme

mneme currently lives inside the HIVEMIND monorepo. To ship it as a standalone, free,
`npm install`-able package (Qdrant-style), do the following once. Steps marked **(needs your
account)** require credentials only you have.

## 1. Extract to a standalone repo **(needs your account)**

```bash
# from the monorepo root
git subtree split --prefix=mneme -b mneme-standalone
# create an empty public repo `mneme` on GitHub, then:
git clone <your monorepo> /tmp/mneme-pub && cd /tmp/mneme-pub
git checkout mneme-standalone
git remote add pub git@github.com:<you>/mneme.git
git push pub mneme-standalone:main
```

After extraction, `.github/workflows/release.yml` (already in this folder) becomes active —
it builds prebuilt `.node` binaries for macOS (arm64/x64), Linux (x64/arm64), and Windows (x64),
and publishes to npm on a `vX.Y.Z` tag.

## 2. CI secrets **(needs your account)**

In the new repo's settings → Secrets:
- `NPM_TOKEN` — an npm automation token (so `npm publish` works in CI).

## 3. Cut a release

```bash
git tag v0.1.0 && git push origin v0.1.0
```

CI builds all platform binaries, runs the wrapper test, and publishes `mneme-node` to npm with
the prebuilt binaries bundled. Users then get a zero-toolchain install:

```bash
npm install mneme-node
```

This downloads the prebuilt `.node` for the user's platform.

## 4. Publish the Rust crates (optional) **(needs your account)**

Publish in this exact order — `mseg` depends on the other three, so it must go last, after they're live:

```bash
cd crate
cargo publish -p mseg-format
cargo publish -p mnsw-index
cargo publish -p mpq
cargo publish -p mseg
```

(Path deps must be replaced with version deps before publishing the dependent crates; or use a
release tool like `release-plz`.)

## 5. The curl installer

`install.sh` already works against any public repo — set `MNEME_REPO`/`MNEME_BRANCH` if you fork:

```bash
curl -fsSL https://raw.githubusercontent.com/<you>/mneme/main/install.sh | bash
```

It builds from source (no published binary needed), so it works the moment the repo is public —
the npm prebuilt-binary path (steps 1-3) is the faster, toolchain-free alternative.

## What's already done

- Apache-2.0 `LICENSE` + `NOTICE`
- `README.md`, `THESIS.md`, frozen `SPEC.md`
- `package.json` with `bin`, `files`, napi `triples`, `index.d.ts` types
- `install.sh` + `mneme` CLI (ingest/recall/compact/status/connect), e2e-verified
- `.github/workflows/release.yml` build+publish matrix

## What needs you

- A GitHub repo + npm token (steps 1-3). Everything else is committed and ready.
