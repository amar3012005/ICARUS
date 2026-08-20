// Bun-only sidecar: the ESM `import ... with { type: "file" }` assertion is how Bun's compiler
// embeds a non-JS asset into a single-file compiled binary (verified live — the resulting path
// is a real, readable file inside the compiled binary at runtime, e.g. `/$bunfs/root/tree-
// sitter-javascript-<hash>.wasm`). graph-native.js itself is CommonJS (require() throughout, to
// stay loadable under plain Node too) and a CommonJS file can't hold a static top-level `import`
// statement — so this lives in its own real ES module, reached only via a dynamic `import()` of
// this exact literal relative path from graph-native.js, gated behind a Bun-runtime check. Bun's
// static bundler follows a literal-string dynamic import() the same way it follows the literal
// require() calls native.js's own Bun branch depends on for the native .node addon — confirmed
// by actually compiling and running this exact pattern, not assumed from docs.
import js from 'tree-sitter-wasms/out/tree-sitter-javascript.wasm' with { type: 'file' };
import ts from 'tree-sitter-wasms/out/tree-sitter-typescript.wasm' with { type: 'file' };
import rust from 'tree-sitter-wasms/out/tree-sitter-rust.wasm' with { type: 'file' };
export default { javascript: js, typescript: ts, rust };
