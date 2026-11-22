const MAX_PREVIEW_RESOLUTION_INDEX = 3;

/**
 * @typedef {object} MediaSubmission
 * @property {string} [id]
 * @property {string} [url]
 * @property {unknown} [is_gallery]
 * @property {unknown} [gallery_data]
 * @property {unknown} [media_metadata]
 * @property {unknown} [preview]
 * @property {unknown} [media_embed]
 * @property {unknown} [media]
 * @property {unknown} [thumbnail]
 * @property {unknown} [post_hint]
 * @property {unknown} [is_video]
 */

/**
 * @typedef {object} MediaData
 * @property {string[]} imageUrls
 * @property {string | null} mediaVideo
 * @property {string | null} mediaHtml
 * @property {number} num_images
 */

/** @typedef {Partial<MediaData>} CachedMedia */

/** @type {(value: unknown) => value is unknown[]} */
const isArray = Array.isArray;

/**
 * @param {unknown} object
 * @param {string} propertyName
 */
function getOwnProperty(object, propertyName) {
    if (object !== null && typeof object === 'object' && Object.hasOwn(object, propertyName)) {
        // The object's own key exists, and its value still needs to be checked by the caller.
        return /** @type {Record<string, unknown>} */ (object)[propertyName];
    }
    return undefined;
}

/**
 * @template T
 * @template {string} Key
 * @param {T} object
 * @param {Key} propertyName
 * @returns {object is T & Record<Key, Key extends keyof NonNullable<T> ? NonNullable<NonNullable<T>[Key]> : unknown>}
 */
function hasProp(object, propertyName) {
    return getOwnProperty(object, propertyName) != null;
}

/**
 * @param {unknown} thumbnail
 * @returns {thumbnail is string}
 */
function isValidThumbnail(thumbnail) {
    return typeof thumbnail === 'string' && thumbnail.length > 0 && thumbnail !== 'default' && thumbnail !== 'nsfw';
}

/** @param {MediaSubmission} submission */
function isGallerySubmission(submission) {
    return getOwnProperty(submission, 'is_gallery') === true;
}

/** @param {unknown[]} resolutions */
function selectPreviewResolution(resolutions) {
    const index = Math.min(resolutions.length - 1, MAX_PREVIEW_RESOLUTION_INDEX);
    return resolutions[index];
}

/** @param {MediaSubmission} submission */
function getGalleryItems(submission) {
    const items = getOwnProperty(getOwnProperty(submission, 'gallery_data'), 'items');
    return isArray(items) ? items : null;
}

/** @param {MediaSubmission} submission */
function getGalleryImageUrls(submission) {
    const context = `Gallery submission ${submission.id} (${submission.url})`;
    const galleryImages = getGalleryItems(submission);
    if (galleryImages === null || galleryImages.length === 0) {
        throw new Error(`${context} is expected to have gallery_data.items but none were returned`);
    }
    const mediaMetadata = getOwnProperty(submission, 'media_metadata');
    if (mediaMetadata === null || typeof mediaMetadata !== 'object') {
        throw new Error(`${context} has gallery_data.items but no media_metadata`);
    }

    return galleryImages.map((image) => {
        const mediaId = getOwnProperty(image, 'media_id');
        if (typeof mediaId !== 'string') {
            throw new Error(`${context} has a gallery item without media_id`);
        }

        const metadata = getOwnProperty(mediaMetadata, mediaId);
        if (metadata == null) {
            throw new Error(`${context} is missing media_metadata for gallery image ${mediaId}`);
        }

        const previews = getOwnProperty(metadata, 'p');
        const previewImages = isArray(previews) ? previews : [];
        const preview = selectPreviewResolution(previewImages);
        const anyPreview = previewImages.find((previewImage) => hasProp(previewImage, 'u'));
        const imageUrl =
            getOwnProperty(preview, 'u') ??
            getOwnProperty(getOwnProperty(metadata, 's'), 'u') ??
            getOwnProperty(anyPreview, 'u');
        if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
            throw new Error(`${context} has no image URL for gallery image ${mediaId}`);
        }
        return imageUrl;
    });
}

/** @param {MediaSubmission} submission */
function getSubmissionPreviewImageUrls(submission) {
    const images = getOwnProperty(getOwnProperty(submission, 'preview'), 'images');
    if (isArray(images)) {
        for (const image of images) {
            const candidates = getOwnProperty(image, 'resolutions');
            const resolutions = isArray(candidates) ? candidates : [];
            const selectedResolution = selectPreviewResolution(resolutions);
            const anyResolution = resolutions.find((resolution) => hasProp(resolution, 'url'));
            const imageUrl =
                getOwnProperty(selectedResolution, 'url') ??
                getOwnProperty(getOwnProperty(image, 'source'), 'url') ??
                getOwnProperty(anyResolution, 'url');
            if (typeof imageUrl === 'string' && imageUrl.length > 0) {
                return [imageUrl];
            }
        }
    }

    const thumbnail = getOwnProperty(submission, 'thumbnail');
    if (isValidThumbnail(thumbnail)) {
        return [thumbnail];
    }
    return [];
}

/**
 * @param {MediaSubmission} submission
 * @returns {{ type: 'embed' | 'html' | 'thumbnail' | 'video', media: string } | null}
 */
function getMedia(submission) {
    const embeddedContent = getOwnProperty(getOwnProperty(submission, 'media_embed'), 'content');
    if (typeof embeddedContent === 'string') {
        return { type: 'embed', media: embeddedContent };
    }

    const media = getOwnProperty(submission, 'media');
    const oembed = getOwnProperty(media, 'oembed');
    const embedHtml = getOwnProperty(oembed, 'html');
    if (typeof embedHtml === 'string') {
        return { type: 'html', media: embedHtml };
    }
    const embedThumbnail = getOwnProperty(oembed, 'thumbnail_url');
    if (typeof embedThumbnail === 'string') {
        return { type: 'thumbnail', media: embedThumbnail };
    }

    const hostedVideo = getOwnProperty(getOwnProperty(media, 'reddit_video'), 'fallback_url');
    if (typeof hostedVideo === 'string') {
        return { type: 'video', media: hostedVideo };
    }
    const preview = getOwnProperty(submission, 'preview');
    const previewVideo = getOwnProperty(getOwnProperty(preview, 'reddit_video_preview'), 'fallback_url');
    if (typeof previewVideo === 'string') {
        return { type: 'video', media: previewVideo };
    }

    return null;
}

/**
 * @param {MediaSubmission} expectedSubmission
 * @param {MediaSubmission} mediaSubmission
 * @param {CachedMedia} mediaData
 * @param {boolean} galleryExpected
 */
function getExpectedMediaError(expectedSubmission, mediaSubmission, mediaData, galleryExpected) {
    if (isGallerySubmission(expectedSubmission) || galleryExpected) {
        try {
            getGalleryImageUrls(mediaSubmission);
            return null;
        } catch (error) {
            return error;
        }
    }

    if (
        expectedSubmission.post_hint === 'image' &&
        (!Array.isArray(mediaData.imageUrls) || mediaData.imageUrls.length === 0)
    ) {
        return new Error(
            `Image submission ${expectedSubmission.id} (${expectedSubmission.url}) has no image media data`,
        );
    }

    if (expectsVideo(expectedSubmission) && !mediaData.mediaVideo && !mediaData.mediaHtml) {
        return new Error(
            `Video submission ${expectedSubmission.id} (${expectedSubmission.url}) has no video or embed metadata`,
        );
    }

    return null;
}

/** @param {MediaSubmission} submission */
function expectsVideo(submission) {
    return (
        submission.is_video === true || submission.post_hint === 'hosted:video' || submission.post_hint === 'rich:video'
    );
}

/**
 * @param {MediaSubmission} submission
 * @returns {MediaData}
 */
function extractSubmissionMedia(submission, galleryExpected = false) {
    const mediaObject = getMedia(submission);
    const isGallery = isGallerySubmission(submission) || galleryExpected;
    const imageUrls = isGallery
        ? getGalleryImageUrls(submission)
        : mediaObject === null
          ? getSubmissionPreviewImageUrls(submission)
          : [];
    return {
        imageUrls,
        mediaVideo: mediaObject?.type === 'video' ? mediaObject.media : null,
        mediaHtml: mediaObject && mediaObject.type !== 'video' ? mediaObject.media : null,
        num_images: isGallery ? imageUrls.length : 0,
    };
}

/**
 * @param {MediaSubmission} submission
 * @param {CachedMedia | null} cachedSubmission
 */
function cachedMediaSatisfiesExpectedType(submission, cachedSubmission) {
    if (!cachedSubmission) {
        return false;
    }

    const cachedImageUrls = Array.isArray(cachedSubmission.imageUrls) ? cachedSubmission.imageUrls : [];
    const imageCount = cachedSubmission.num_images ?? 0;
    const cachedImageCount = Number.isInteger(imageCount) && imageCount > 0 ? imageCount : cachedImageUrls.length;
    const galleryExpected = isGallerySubmission(submission) || cachedImageCount > 0;

    if (galleryExpected) {
        const galleryItems = getGalleryItems(submission);
        if (galleryItems !== null) {
            return galleryItems.length > 0 ? cachedImageUrls.length >= galleryItems.length : cachedImageUrls.length > 0;
        }
        return cachedImageCount > 0 && cachedImageUrls.length >= cachedImageCount;
    }
    if (submission.post_hint === 'image') {
        return cachedImageUrls.length > 0;
    }
    if (expectsVideo(submission)) {
        return (
            (typeof cachedSubmission.mediaVideo === 'string' && cachedSubmission.mediaVideo.length > 0) ||
            (typeof cachedSubmission.mediaHtml === 'string' && cachedSubmission.mediaHtml.length > 0)
        );
    }
    return true;
}

/**
 * @template {CachedMedia & MediaSubmission} Submission
 * @param {Submission} submission
 * @param {CachedMedia | null} cachedSubmission
 * @returns {Omit<Submission, keyof CachedMedia> & CachedMedia}
 */
function mergeMediaWithCache(submission, cachedSubmission) {
    if (!cachedSubmission) {
        return submission;
    }

    const merged = { ...submission };
    const currentImageUrls = Array.isArray(merged.imageUrls) ? merged.imageUrls : [];
    const cachedImageUrls = Array.isArray(cachedSubmission.imageUrls) ? cachedSubmission.imageUrls : [];
    if (currentImageUrls.length < cachedImageUrls.length) {
        merged.imageUrls = cachedImageUrls;
    }

    for (const field of /** @type {const} */ (['mediaVideo', 'mediaHtml'])) {
        const currentValue = merged[field];
        const cachedValue = cachedSubmission[field];
        const hasNewValue = typeof currentValue === 'string' && currentValue.length > 0;
        if (!hasNewValue && typeof cachedValue === 'string' && cachedValue.length > 0) {
            merged[field] = cachedValue;
        }
    }

    const numImages = merged.num_images ?? 0;
    const cachedNumImages = cachedSubmission.num_images ?? 0;
    const newImageCount = Number.isInteger(numImages) ? numImages : 0;
    const cachedImageCount = Number.isInteger(cachedNumImages) ? cachedNumImages : 0;
    if (newImageCount < cachedImageCount) {
        merged.num_images = cachedImageCount;
    } else if (isGallerySubmission(merged) && newImageCount === 0 && cachedImageUrls.length > 0) {
        merged.num_images = cachedImageUrls.length;
    }

    return merged;
}

module.exports = {
    hasProp,
    isGallerySubmission,
    getGalleryItems,
    getExpectedMediaError,
    extractSubmissionMedia,
    cachedMediaSatisfiesExpectedType,
    mergeMediaWithCache,
};
