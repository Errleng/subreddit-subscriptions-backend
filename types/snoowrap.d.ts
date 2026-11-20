import 'snoowrap';

declare module 'snoowrap' {
    export const errors: {
        RateLimitError: ErrorConstructor;
    };
}
