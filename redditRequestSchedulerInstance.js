const reddit = require('./reddit');
const {
    RedditRequestScheduler,
    RedditRateLimitError,
    RedditQueueOverloadError,
    RedditRequestAbortedError,
} = require('./redditRequestScheduler');

const scheduler = new RedditRequestScheduler(reddit);

module.exports = Object.assign(scheduler, {
    RedditRateLimitError,
    RedditQueueOverloadError,
    RedditRequestAbortedError,
});
