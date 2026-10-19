# Optional local source modules

This workspace now contains independent source checkouts at `agent-bus/` and `computer-use/`.
Both are ignored by the flagship Git repository. They retain their original Git history,
dependencies and entrypoints. Private Bus source must not enter the public ICARUS package.

```sh
python3 scripts/modules.py status
# On another checkout, fetch only the source you explicitly select:
python3 scripts/modules.py setup computer-use
python3 scripts/modules.py setup agent-bus  # requires authorized private-repository access
```

These commands fetch source and inspect local Git metadata. They do not install dependencies,
register agents, create cloud desktops, or start services. Existing checkouts are never reset or
updated automatically. Run each module from its own directory, following its own README and
AGENTS instructions. Review its independent license before redistribution.

- **Bus:** `modules/agent-bus/agent-bus` is the Python CLI. See its README and
  `docs/REMOTE_BUS.md`. Starting or joining the live bus requires the SINGULANCE Agent Bus
  onboarding procedure and an exact session/worktree binding. No participant was registered
  and no message was sent during this organization task.
- **Computer Use:** use Node **22** and `npm ci` in `modules/computer-use`, then `npm test`.
  E2B-backed execution additionally requires the documented provider credentials/template and
  incurs provider use. See `modules/computer-use/docs/SETUP.md` before starting the pool.

These modules are independently runnable upstream components, not wired ICARUS CLI adapters.
The proposed ICARUS/Bus bridge remains unshipped. Memory and Harness stay in their established
`crate/` paths. Runtime-Runner remains outside this workspace.
