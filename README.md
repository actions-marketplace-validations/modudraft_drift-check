# Modudraft drift check

A GitHub Action that checks whether your Modudraft architecture diagram still matches the code in your repository. It runs `npx @modudraft/mcp check`, comments on pull requests, and fails the job when the diagram has drifted.

## Usage

```yaml
name: drift
on: [pull_request]
permissions:
  contents: read
  pull-requests: write
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: modudraft/drift-check@v1
        with:
          api-key: ${{ secrets.MODUDRAFT_API_KEY }}
          diagram: <diagram-id>
```

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `api-key` | required | Modudraft API key (repository secret). |
| `diagram` | | Diagram id. Optional when `modudraft.json` names it. |
| `dir` | `.` | The repo (or a folder in it) to check, relative to the workspace. Paths in `modudraft.json` are relative to the git repo root, and `modudraft.json` itself is read from there. |
| `on-drift` | `fail` | `report` (never fails), `fail` (exit 1 on drift) or `update-diagram` (write the change set to the diagram). |
| `comment` | `true` | On pull requests, also post the result as a PR comment, updated in place on each run. The job summary is always written. |
| `remove-missing` | `false` | Remove diagram items whose source is gone when updating. |
| `allow-update-on-pr` | `false` | Permit `update-diagram` on pull requests. |
| `mcp-version` | `latest` | Version of `@modudraft/mcp` to run. Pin it (e.g. `mcp-version: 0.20.0`) for fully reproducible CI. |
| `github-token` | `${{ github.token }}` | Token used to post the comment. The comment is updated in place only when it was posted by a bot account (the default `github.token`); with a personal access token each run posts a new comment. |

Exit codes: `0` in sync, report mode, or update succeeded; `1` drift with `on-drift: fail`; `2` error (bad input, unparseable file, sources that match no files, nothing checked, read-only key). Per-file errors are listed in the comment and the job summary.

## Permissions

Commenting needs `pull-requests: write`. `update-diagram` needs an API key with write access; a read-only key fails with exit 2.

## Two-workflow example

Check on pull requests (read-only, never writes), then update the diagram after merge:

```yaml
# .github/workflows/drift-pr.yml
on: [pull_request]
permissions: { contents: read, pull-requests: write }
jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: modudraft/drift-check@v1
        with:
          api-key: ${{ secrets.MODUDRAFT_API_KEY }}
          diagram: <diagram-id>
          on-drift: fail
```

```yaml
# .github/workflows/drift-main.yml
on:
  push:
    branches: [main]
permissions: { contents: read }
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: modudraft/drift-check@v1
        with:
          api-key: ${{ secrets.MODUDRAFT_API_KEY }}
          diagram: <diagram-id>
          on-drift: update-diagram
```

`update-diagram` on a pull request is refused unless you set `allow-update-on-pr: true`.

## Coverage

The check covers the structured files Modudraft can import into a diagram: Docker Compose; Kubernetes YAML, Terraform and CloudFormation; SQL DDL, Prisma, DBML, Rails `schema.rb`, TypeORM, SQLAlchemy and dbt; OpenAPI 2/3, GraphQL SDL, `.proto`, Postman, Insomnia v4 and AsyncAPI. `.env` files and dependency manifests are never read. Hand-made diagram content (items without a source, positions, notes) is never touched. List files or name target nodes in `modudraft.json`. Output always lists the files checked.

## Security notes

- PR comments are only posted on `pull_request` events. Other events write to the job summary only.
- `update-diagram` is allowed only on `push`, `workflow_dispatch` and `schedule`; any other event (including `pull_request_target`, `issue_comment`, `workflow_run`) is refused unless `allow-update-on-pr: true`.
- Do not combine `pull_request_target` with checking out the PR head code while the API key is available: that runs untrusted code with your secrets.
- The CLI runs from the runner temp directory (not your checkout) so a `.npmrc` in the repo cannot redirect the package download.
- CLI output (stdout and stderr) is echoed inside `::stop-commands::` so repository text cannot inject workflow commands.
- The Action calls `actions/setup-node` (Node 22), which changes the Node version for the rest of the job.

## Fork pull requests

GitHub does not pass secrets to workflows from forks, so `api-key` is empty. On pull request events the Action then logs a warning and skips the check without failing; on any other event a missing key is an error (exit 2). Comments from forks may also be blocked by a read-only token; a failed comment is a warning and the check result still decides the exit code.
