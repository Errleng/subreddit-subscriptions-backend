# Reddit API findings

Notes from reviewing the backend's Reddit request flow. This file is a working record; items under “To verify” still need runtime comparison against representative Reddit posts.

## Runtime call inventory

| Caller and location | App/backend request | Reddit request | Purpose and frequency |
| --- | --- | --- | --- |
| `SubredditListComponent.addSub()` in the frontend; `/valid/subreddit/:subredditName` in `api/apiRouter.js` | `GET /api/valid/subreddit/:subredditName` | Snoowrap `getSubreddit(name).fetch()` sends `GET /r/{name}/about` | Checks that a subreddit exists when the user adds it. Errors are currently all returned to the client as 404. |
| `SubredditComponent.loadData()` → `RedditService.getSubmissions()`; feed route in `api/apiRouter.js` | `GET /api/subreddit/:subredditName/:sortType/:sortTime/:numSubmissions` | One of `GET /r/{name}/hot`, `/new`, `/top`, `/rising`, or `/controversial` | Gets the requested feed and current post metrics. The frontend currently sends `sortType=top`; the backend supports all five. Called when a subreddit component loads and when its settings change. A short result can trigger up to five identical listing requests. |
| `updateSubmissionMedia()` in `api/apiRouter.js` | Part of the feed request; no separate app route | Snoowrap `Submission.fetch()` sends `GET /comments/{id}` | With `config.fetchAll: true`, called for each non-self post that is uncached or older than `minutesUntilUpdate` (currently 1,440 minutes). The response contains the submission and a comments listing; the app does not use `.comments`. |
| Snoowrap request handler configured in `reddit.js` | No separate app route | `POST https://www.reddit.com/api/v1/access_token` with the refresh-token grant | Automatically gets an access token when a Snoowrap requester has no usable token. Snoowrap caches that token until expiry, so this is not sent for every Reddit request. |
| Express route `/` in `api/apiRouter.js` | `GET /api/` | None | Returns the API greeting; the frontend does not currently call it. |

The frontend calls its backend over HTTP; the first three rows show the corresponding Reddit requests. MongoDB lookups and writes also happen during feed requests, but they are not Reddit API calls. Snoowrap is configured with a 1,000 ms request delay between Reddit requests.

## Current rate-limit behavior

- The subreddit list uses `*ngFor` to create every `ss-subreddit` component at page load. Each component calls `loadData()` in `ngOnInit()`, so a page with dozens of configured subreddits enqueues dozens of feed requests before the user scrolls to them.
- The frontend `RateLimiterService` serializes `/api/subreddit` requests from one browser tab, but dispatches the next immediately after the previous response or error. It does not pause based on response headers or a minimum interval. Because the components are created by `*ngFor` over the settings array and queue items are FIFO, requests likely start in configured order; this should be made explicit and measured.
- Each subreddit component retries any failed feed request up to four times after a random 5–60 second delay. The delay is selected once per component; errors are not filtered by status.
- Snoowrap serializes Reddit requests from its requester with the configured 1,000 ms `requestDelay`. It reads Reddit's `x-ratelimit-remaining` and `x-ratelimit-reset` response headers. Its default `continueAfterRatelimitError` is `false`, and its built-in retry list is 502, 503, 504, and 522—not 429.
- Snoowrap's queue and rate-limit counters are in memory for that requester/process. Separate backend instances do not share this state.

## One-time OAuth setup utility

`get_refresh_token.js` is not part of normal feed operation:

- `snoowrap.getAuthUrl()` constructs the Reddit authorization URL; the user opens it in a browser. Reddit serves the authorization page at `/api/v1/authorize`, with `http://localhost:8080` as the redirect URI and `*` as the requested scope.
- After the user approves, the browser returns an authorization code to the helper's local callback. `snoowrap.fromAuthCode()` exchanges it with `POST /api/v1/access_token` and prints the resulting refresh token.

## Calls defined but not used at runtime

- `getSubmissionPreviewImagesWrapper()` and `getMediaWrapper()` each contain a possible `submission.fetch()` call, but neither helper has a call site.
- `getContentByIds()` maps to Reddit's `/api/info` endpoint. It was used in the investigations below, but the application does not currently call it.

## Costs, priorities, and proposed optimizations

The common workload is loading a page with many configured subreddits and scrolling through it. Reloads, settings changes, subreddit additions, and MongoDB work are less frequent or are not current bottlenecks.

1. **High priority — remove broad per-post detail fetches.** Set `config.fetchAll` to `false` by default. The sampled listings already carried the metrics and media fields used by the app; a real `Submission.fetch()` added no app media output and returned an unused comments listing with 68 entries. Keep a conditional fallback for an untested post shape that is actually missing a required field.
2. **Fallback only — batch missing submission data.** If runtime observations find posts whose needed media fields are absent from a listing, try one `getContentByIds()` `/api/info` request for the affected IDs. The samples showed no useful additions for non-text media posts, so do not add this request to the normal path without evidence.
3. **Keep the short-listing retries.** These retries are intentional: Reddit can return a partial listing (for example, 6 of 10) and then return the full listing on a later request. The current loop makes up to five requests and returns only the single longest response. A candidate improvement is to merge results by submission ID across attempts, preserve ranking order, stop once the requested number of unique posts is reached, and retain the current attempt cap. Record per-attempt counts and response status so this behavior can be measured. Pagination with `after` remains appropriate when intentionally requesting beyond one Reddit page, not as a replacement for these recovery retries.
4. **High priority — handle rate limits centrally while keeping eager loading.** Keep loading every configured subreddit in the background; explicitly prioritize requests top-to-bottom in the user's configured order so the first feeds are ready while later ones continue. The current FIFO may already approximate this, but it is implicit. Have the backend use Snoowrap's rate-limit counters/reset time to pace Reddit calls. If it cannot safely hold a request until the quota resets, return a rate-limit response with `Retry-After`; the frontend queue should pause all pending requests for that duration and requeue the affected feed at the server-directed time. For other transient network/server errors, keep only a couple of bounded frontend retries with backoff; do not apply those retries to rate-limit responses or permanent 4xx errors. Avoid overlapping retry loops. If deployment uses multiple backend instances, account for their separate in-memory Snoowrap counters.
5. **Low priority — feed response cache.** A short cache keyed by subreddit, sort, time range, and limit could reduce repeat calls, but reloads and settings changes are rare, so defer unless measurements show it helps the common initial-load workload.
6. **Deferred — subreddit validation call.** Adding a subreddit makes one `/about` request before its first feed request, but adding subscriptions is rare; keep the clearer validation flow for now.
7. **Deferred — MongoDB batching.** Per-submission lookups and writes add database round trips, but the database is not the current bottleneck.

The media helper functions `getSubmissionPreviewImagesWrapper()` and `getMediaWrapper()` contain fetch logic but have no call sites. If selective enrichment is later needed, combine it into one check so two helpers cannot fetch the same post independently.

## To verify

- Check edge-case posts that omit or restrict media fields; retain conditional enrichment only if the frontend loses a needed field.
- Observe Reddit response status and rate-limit metadata during a page load with many configured subreddits; use that to size the request queue and backoff.
- Verify that the initial feed request order follows the configured subreddit order and that later requests continue while earlier feeds are being read.
- Measure how often the underfilled-listing retries recover additional unique posts, and whether merging IDs across attempts improves results.

## Live probe status

- Initial probes returned HTTP 403 during OAuth/listing requests; a later retry through the same app path succeeded. The cause of the temporary 403 remains unknown.
- Using `dotenv.config()` and Snoowrap 1.23.0 via `reddit.js`, `r/aww/top` for `day` with a limit of 10 returned 10 submissions. All 10 included `score`, `upvote_ratio`, and `num_comments`; 5 had non-empty preview images, 3 had Reddit video fallback URLs, and 5 had gallery items and media metadata.
- A single `getContentByIds()` batch returned all 10. For those posts it matched the listing's metrics and tested media fields without adding any non-empty fields missing from the listing.
- Additional top listings of 12 posts each from `r/pics`, `r/videos`, and `r/AskReddit` returned 36 posts; one `getContentByIds()` batch returned all 36. On the tested non-text media posts, listing and batch data matched for the app's media fields. All 12 `AskReddit` posts were self posts, which the route skips; `/api/info` added useful thumbnail values for these self posts, but that does not affect the current route behavior.
- One real `Submission.fetch()` on a sampled external-video post left the app's media output unchanged and returned a comments listing with 68 entries. A search of backend and frontend source found no use of the Snoowrap `.comments` property. This confirms that the individual fetch can retrieve data the app does not consume.
- The samples covered preview images, galleries, Reddit-hosted video fields, and external embeds. They do not prove every possible post shape is covered; keep an edge-case fallback if desired and monitor missing media fields.
