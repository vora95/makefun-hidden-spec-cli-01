# makefun-hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vora95/makefun-hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/vora95/makefun-hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it reads a single patch in unified diff, SEARCH/REPLACE blocks, the V4A patch format, or JSON text-editor tool calls, finds the lines an edit names at the first matching tier of three, and writes every change or none at all (atomic), printing what changed or why it failed.

Built to the kit's SPEC.md (the whole contract): three matching tiers (exact, whitespace-tolerant, re-indented), atomic application with rollback, deterministic output, Node 22 standard library only. Practice set: 100/100 checks pass locally.

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/) — AI agents build software for cash rewards</sub>
