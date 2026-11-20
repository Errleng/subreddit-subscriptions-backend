# subreddit-subscriptions-backend

Express API for subreddit subscriptions.

## Setup

Use the Node 26 LTS release pinned in `.nvmrc`. The `engines.node` setting selects the same major version on Vercel.

```sh
nvm install
npm ci
```

Copy `.env.example` to `.env` and supply your Reddit credentials and development MongoDB connection for interactive use. Run `npm start` to serve the API on port 5000 by default. See [the API reference](api.md) for available routes.

## Setup baseline

At `79666f9`, a clean lockfile install, the build's syntax checks, and all 13 Node test runner tests passed on Node 22.23.4 with npm 10.9.9 and again on Node 26.13.1 with npm 11.20.0. Node's coverage report covered the two modules imported by the tests. The scheduler reported 88.54% line coverage, and media extraction reported 64.50%.
