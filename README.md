# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/xcaracalid/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/xcaracalid/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node process, standard library only: git smart HTTP (protocol v2 and v0, with shallow fetch and packfile deltas), the REST v3 API (repos, contents, branches, commits, labels, issues, pull requests with three-way squash merges), a GraphQL endpoint with Relay-style global ids, introspection and cursor pagination, and an MCP endpoint (server/discover plus the legacy initialize handshake) — all served from a single in-memory store, so every surface sees the same repositories, issues and pull requests.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jt238wx7&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
