# subreddit-subscriptions-backend

Express API for subreddit subscriptions.

## Setup

Use the Node 26 LTS release pinned in `.nvmrc`. The `engines.node` setting selects the same major version on Vercel.

```sh
nvm install
npm ci
```

Copy `.env.example` to `.env` and supply your Reddit credentials and development MongoDB connection for interactive use. Run `npm start` to serve the API on port 5000 by default. See [the API reference](api.md) for available routes.

## Local checks

| Command                 | Purpose                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `npm run devstart`      | Run the local server and restart on code changes.                                   |
| `npm run build`         | Check JavaScript syntax, including the `bin/www` entry point.                       |
| `npm run typecheck`     | Check application JavaScript, test files, and Vitest configuration with TypeScript. |
| `npm test`              | Run the Vitest suite once.                                                          |
| `npm run test:watch`    | Re-run tests as files change.                                                       |
| `npm run test:coverage` | Write V8 coverage reports to `coverage/` and enforce minimum coverage.              |
| `npm run lint`          | Run type-aware Oxlint. Use `npm run lint:fix` to apply available fixes.             |
| `npm run format:check`  | Check Oxfmt formatting. Use `npm run format` to apply it.                           |
| `npm run check`         | Run the build, type check, lint, formatting, and tests with coverage.               |

Keep tests in `test/` with the `.test.mjs` suffix. The HTTP tests run the real Express app on loopback with stubbed Reddit and MongoDB modules. The test suite and `npm run check` need no external services or credentials.

Vitest requires 90% coverage for statements, branches, and lines, and 93% for functions.

TypeScript checks JavaScript through `checkJs` with strict mode, checked indexed access, exact optional properties, and control-flow checks. The test project extends the service rules. Both projects emit no files and skip third-party declaration checking. This service runs JavaScript directly, so the build is a syntax check.

Type-aware linting checks promise handling, unsafe uses of `any`, and exhaustive switches in source and test files.

### Pre-commit and CI

Run `git rev-parse --git-path hooks` to check for existing hooks. In a clone with only Git's samples, activate the tracked pre-commit hook once.

```sh
git config --local core.hooksPath .githooks
```

The hook runs `npm run check` with the Node version in your shell. If the clone has existing hooks, integrate the check into that setup.

The Build and Test workflow installs from the lockfile on the Node version in `.nvmrc` and runs `npm run check`.

Secret Scan uses pinned Gitleaks with its default rules and an additional rule for MongoDB connection URIs that embed a username and password. It scans merge diffs and redacts findings. The workflow exempts two exact historical findings for a rotated credential and a placeholder in the original environment template.

Hosted runs and required-check enforcement need separate verification. Before pushing, follow the outgoing-history audit in [the setup guide](setup/SETUP.md).

## Setup baseline

At `79666f9`, a clean lockfile install, the build's syntax checks, and all 13 Node test runner tests passed on Node 22.23.4 with npm 10.9.9 and again on Node 26.13.1 with npm 11.20.0. Node's coverage report covered the two modules imported by the tests. The scheduler reported 88.54% line coverage, and media extraction reported 64.50%.

Vitest preserved the existing 13 tests. The initial Vitest run reported 40.94% statements, 38.77% branches, 67.14% functions, and 40.45% lines. With 28 tests, coverage increased to 83.39% statements, 65.30% branches, 93.33% functions, and 83.27% lines. Expanding to 90 tests brought coverage to 96.53% statements, 90.24% branches, 100% functions, and 96.47% lines.
