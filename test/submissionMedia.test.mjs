import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'vitest';

const require = createRequire(import.meta.url);
/** @type {typeof import('../api/submissionMedia.js')} */
const media = require('../api/submissionMedia.js');

const { extractSubmissionMedia, getExpectedMediaError, cachedMediaSatisfiesExpectedType, mergeMediaWithCache } = media;
const imageUrl = 'https://images.example/fixture.jpg';
const videoUrl = 'https://videos.example/fixture.mp4';
const embedHtml = '<iframe src="https://videos.example/embed"></iframe>';

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

test('falls back to another preview when the preferred resolution and source are missing', () => {
    const submission = {
        preview: { images: [{ resolutions: [{ url: imageUrl }, {}] }] },
        thumbnail: 'https://images.example/thumbnail.jpg',
    };
    assert.deepEqual(extractSubmissionMedia(submission).imageUrls, [imageUrl]);
});

test('uses a thumbnail when the preview has no usable image', () => {
    const submission = { preview: { images: [{ source: { url: '' } }, {}] }, thumbnail: imageUrl };
    assert.deepEqual(extractSubmissionMedia(submission).imageUrls, [imageUrl]);
});

test.each(['', 'default', 'nsfw'])('ignores the thumbnail placeholder %j', (thumbnail) => {
    assert.deepEqual(extractSubmissionMedia({ thumbnail }).imageUrls, []);
});

test.each([
    { media_embed: { content: embedHtml }, media: { oembed: { html: '<p>Lower-priority embed</p>' } } },
    { media_embed: {}, media: { oembed: { html: embedHtml, thumbnail_url: imageUrl } } },
])('extracts the available embed HTML from %j', (submission) => {
    assert.deepEqual(extractSubmissionMedia(submission), {
        imageUrls: [],
        mediaVideo: null,
        mediaHtml: embedHtml,
        num_images: 0,
    });
});

test('preserves the oEmbed thumbnail as the media fallback when no HTML is returned', () => {
    const submission = { media: { oembed: { thumbnail_url: imageUrl } } };
    assert.deepEqual(extractSubmissionMedia(submission), {
        imageUrls: [],
        mediaVideo: null,
        mediaHtml: imageUrl,
        num_images: 0,
    });
});

test('uses preview video when the hosted video and oEmbed have no usable media', () => {
    const submission = {
        media: { reddit_video: {}, oembed: {} },
        preview: { reddit_video_preview: { fallback_url: videoUrl } },
    };
    assert.equal(extractSubmissionMedia(submission).mediaVideo, videoUrl);
});

test('uses another gallery preview when the preferred preview and source are missing', () => {
    const submission = {
        is_gallery: true,
        gallery_data: { items: [{ media_id: 'first' }] },
        media_metadata: { first: { p: [{ u: imageUrl }, {}] } },
    };
    assert.deepEqual(extractSubmissionMedia(submission).imageUrls, [imageUrl]);
});

test.each([
    { name: 'null items', items: null, metadata: {}, message: /expected to have gallery_data.items/ },
    { name: 'empty items', items: [], metadata: {}, message: /expected to have gallery_data.items/ },
    {
        name: 'missing metadata',
        items: [{ media_id: 'first' }],
        metadata: undefined,
        message: /no media_metadata/,
    },
    {
        name: 'non-object metadata',
        items: [{ media_id: 'first' }],
        metadata: 'invalid',
        message: /no media_metadata/,
    },
    { name: 'missing item ID', items: [{}], metadata: {}, message: /without media_id/ },
    {
        name: 'missing item metadata',
        items: [{ media_id: 'first' }],
        metadata: {},
        message: /missing media_metadata for gallery image first/,
    },
    {
        name: 'missing image URL',
        items: [{ media_id: 'first' }],
        metadata: { first: {} },
        message: /no image URL for gallery image first/,
    },
    {
        name: 'empty image URL',
        items: [{ media_id: 'first' }],
        metadata: { first: { s: { u: '' } } },
        message: /no image URL for gallery image first/,
    },
])('rejects incomplete gallery data with $name', ({ items, metadata, message }) => {
    const submission = {
        id: 'gallery-fixture',
        is_gallery: true,
        gallery_data: { items },
        media_metadata: metadata,
    };
    assert.throws(() => extractSubmissionMedia(submission), message);
});

test('validates gallery media in the returned detail when the listing identifies a gallery', () => {
    const listing = { id: 'gallery-fixture', is_gallery: true };
    const detail = { id: listing.id, gallery_data: { items: [{ media_id: 'first' }] } };
    assert.match(getExpectedMediaError(listing, detail, { imageUrls: [] }, false)?.message ?? '', /no media_metadata/);

    const completeDetail = { ...detail, media_metadata: { first: { s: { u: imageUrl } } } };
    const mediaData = extractSubmissionMedia(completeDetail, true);
    assert.equal(getExpectedMediaError(listing, completeDetail, mediaData, false), null);
});

test.each([
    [{ post_hint: 'image' }, /no image media data/],
    [{ is_video: true }, /no video or embed metadata/],
    [{ post_hint: 'rich:video', preview: { reddit_video_preview: {} } }, /no video or embed metadata/],
])('reports missing expected media for %j', (submission, message) => {
    const result = extractSubmissionMedia(submission);
    assert.match(getExpectedMediaError(submission, submission, result, false)?.message ?? '', message);
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

test.each([
    [{ is_gallery: true, gallery_data: { items: [] } }, { imageUrls: [imageUrl] }, true],
    [{ is_gallery: true, gallery_data: { items: [] } }, { imageUrls: [] }, false],
    [{ is_gallery: true }, { imageUrls: [] }, false],
    [{ is_gallery: true }, { num_images: 2, imageUrls: [imageUrl] }, false],
    [{ post_hint: 'image' }, { imageUrls: [] }, false],
    [{ post_hint: 'rich:video' }, { mediaVideo: videoUrl }, true],
    [{ is_video: true }, { mediaVideo: '', mediaHtml: embedHtml }, true],
    [{ post_hint: 'hosted:video' }, { mediaHtml: '' }, false],
    [{ is_video: true }, { mediaHtml: null }, false],
])('checks whether cached media satisfies %j with %j', (submission, cache, expected) => {
    assert.equal(cachedMediaSatisfiesExpectedType(submission, cache), expected);
});

test('restores gallery count from legacy cached images', () => {
    const submission = { is_gallery: true, num_images: 0 };
    assert.deepEqual(mergeMediaWithCache(submission, { imageUrls: [imageUrl] }), {
        ...submission,
        num_images: 1,
        imageUrls: [imageUrl],
    });
});

test('preserves a new video and restores missing embed HTML from the cache', () => {
    const submission = { mediaVideo: videoUrl, mediaHtml: null };
    const cached = { mediaVideo: 'https://videos.example/older.mp4', mediaHtml: embedHtml };
    assert.deepEqual(mergeMediaWithCache(submission, cached), { mediaVideo: videoUrl, mediaHtml: embedHtml });
});
