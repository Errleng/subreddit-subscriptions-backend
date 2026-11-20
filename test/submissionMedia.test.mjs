import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'vitest';

const require = createRequire(import.meta.url);
/** @type {typeof import('../api/submissionMedia.js')} */
const media = require('../api/submissionMedia.js');

const { extractSubmissionMedia, cachedMediaSatisfiesExpectedType, mergeMediaWithCache } = media;

test('extracts every gallery image using each item media_id', () => {
    const submission = {
        id: 'gallery1',
        url: 'https://reddit.com/gallery/gallery1',
        is_gallery: true,
        gallery_data: {
            items: [{ media_id: 'first' }, { media_id: 'second' }],
        },
        media_metadata: {
            first: { p: [{ u: 'https://images.example/first.jpg' }] },
            second: { p: [{ u: 'https://images.example/second.jpg' }] },
        },
    };

    assert.deepEqual(extractSubmissionMedia(submission), {
        imageUrls: ['https://images.example/first.jpg', 'https://images.example/second.jpg'],
        mediaVideo: null,
        mediaHtml: null,
        num_images: 2,
    });
});

test('extracts a suitable preview URL for an image submission', () => {
    const submission = {
        id: 'image1',
        post_hint: 'image',
        preview: {
            images: [
                {
                    resolutions: [
                        { url: 'https://images.example/small.jpg' },
                        { url: 'https://images.example/medium.jpg' },
                        { url: 'https://images.example/large.jpg' },
                        { url: 'https://images.example/preview.jpg' },
                    ],
                    source: { url: 'https://images.example/original.jpg' },
                },
            ],
        },
    };

    assert.deepEqual(extractSubmissionMedia(submission), {
        imageUrls: ['https://images.example/preview.jpg'],
        mediaVideo: null,
        mediaHtml: null,
        num_images: 0,
    });
});

test('extracts hosted video media', () => {
    const submission = {
        id: 'video1',
        is_video: true,
        media: {
            reddit_video: { fallback_url: 'https://v.redd.it/video1/DASH_720.mp4' },
        },
    };

    assert.deepEqual(extractSubmissionMedia(submission), {
        imageUrls: [],
        mediaVideo: 'https://v.redd.it/video1/DASH_720.mp4',
        mediaHtml: null,
        num_images: 0,
    });
});

test('checks gallery cache against the current item count and preserves fuller cached media', () => {
    const listingSubmission = {
        id: 'gallery1',
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'first' }, { media_id: 'second' }] },
    };
    const partialCache = {
        imageUrls: ['https://images.example/first.jpg'],
        num_images: 1,
    };
    const fullCache = {
        imageUrls: ['https://images.example/first.jpg', 'https://images.example/second.jpg'],
        num_images: 2,
    };

    assert.equal(cachedMediaSatisfiesExpectedType(listingSubmission, partialCache), false);
    assert.equal(cachedMediaSatisfiesExpectedType(listingSubmission, fullCache), true);

    const refreshedSubmission = {
        ...listingSubmission,
        imageUrls: ['https://images.example/first.jpg'],
        num_images: 1,
    };
    assert.deepEqual(mergeMediaWithCache(refreshedSubmission, fullCache), {
        ...refreshedSubmission,
        imageUrls: fullCache.imageUrls,
        num_images: 2,
    });
});
