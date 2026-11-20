const MAX_PREVIEW_RESOLUTION_INDEX = 3;

function hasProp(object, propertyName) {
    return (
        object !== null &&
        typeof object === 'object' &&
        Object.prototype.hasOwnProperty.call(object, propertyName) &&
        object[propertyName] !== null &&
        object[propertyName] !== undefined
    );
}

function isValidThumbnail(thumbnail) {
    return thumbnail.length > 0 && thumbnail !== 'default' && thumbnail !== 'nsfw';
}

function isGallerySubmission(submission) {
    return hasProp(submission, 'is_gallery') && submission.is_gallery === true;
}

function selectPreviewResolution(resolutions) {
    if (!Array.isArray(resolutions) || resolutions.length === 0) {
        return null;
    }

    const index = Math.min(resolutions.length - 1, MAX_PREVIEW_RESOLUTION_INDEX);
    return resolutions[index];
}

function getGalleryImageUrls(submission, galleryExpected = false) {
    if (!isGallerySubmission(submission) && !galleryExpected) {
        return [];
    }

    const context = `Gallery submission ${submission.id} (${submission.url})`;
    if (
        !hasProp(submission, 'gallery_data') ||
        !Array.isArray(submission.gallery_data.items) ||
        submission.gallery_data.items.length === 0
    ) {
        throw new Error(`${context} is expected to have gallery_data.items but none were returned`);
    }
    if (!hasProp(submission, 'media_metadata') || typeof submission.media_metadata !== 'object') {
        throw new Error(`${context} has gallery_data.items but no media_metadata`);
    }

    const galleryImages = submission.gallery_data.items;
    const imageUrls = galleryImages.map((image) => {
        if (!hasProp(image, 'media_id')) {
            throw new Error(`${context} has a gallery item without media_id`);
        }

        const metadata = submission.media_metadata[image.media_id];
        if (!hasProp(submission.media_metadata, image.media_id)) {
            throw new Error(`${context} is missing media_metadata for gallery image ${image.media_id}`);
        }

        const previewImages = Array.isArray(metadata.p) ? metadata.p : [];
        const preview = selectPreviewResolution(previewImages);
        const anyPreview = previewImages.find((previewImage) => hasProp(previewImage, 'u'));
        let imageUrl = null;
        if (hasProp(preview, 'u')) {
            imageUrl = preview.u;
        } else if (hasProp(metadata.s, 'u')) {
            imageUrl = metadata.s.u;
        } else if (hasProp(anyPreview, 'u')) {
            imageUrl = anyPreview.u;
        }
        if (typeof imageUrl !== 'string' || imageUrl.length === 0) {
            throw new Error(`${context} has no image URL for gallery image ${image.media_id}`);
        }
        return imageUrl;
    });

    return imageUrls;
}

function getSubmissionPreviewImageUrls(submission) {
    if (isGallerySubmission(submission)) {
        return getGalleryImageUrls(submission);
    }

    if (hasProp(submission, 'preview') && Array.isArray(submission.preview.images)) {
        for (const image of submission.preview.images) {
            const resolutions = Array.isArray(image.resolutions) ? image.resolutions : [];
            const selectedResolution = selectPreviewResolution(resolutions);
            const anyResolution = resolutions.find((resolution) => hasProp(resolution, 'url'));
            let imageUrl = null;
            if (hasProp(selectedResolution, 'url')) {
                imageUrl = selectedResolution.url;
            } else if (hasProp(image.source, 'url')) {
                imageUrl = image.source.url;
            } else if (hasProp(anyResolution, 'url')) {
                imageUrl = anyResolution.url;
            }
            if (typeof imageUrl === 'string' && imageUrl.length > 0) {
                return [imageUrl];
            }
        }
    }

    if (hasProp(submission, 'thumbnail') && isValidThumbnail(submission.thumbnail)) {
        return [submission.thumbnail];
    }
    return [];
}

function getMedia(submission) {
    if (hasProp(submission, 'media_embed')) {
        const { media_embed } = submission;
        if (hasProp(media_embed, 'content')) {
            return { type: 'embed', media: media_embed.content };
        }
    }

    if (hasProp(submission, 'media')) {
        const { media } = submission;
        if (hasProp(media, 'oembed')) {
            const { oembed } = media;
            if (hasProp(oembed, 'html')) {
                return { type: 'html', media: oembed.html };
            }
            if (hasProp(oembed, 'thumbnail_url')) {
                return { type: 'thumbnail', media: oembed.thumbnail_url };
            }
        }
        if (hasProp(media, 'reddit_video')) {
            const { reddit_video } = media;
            if (hasProp(reddit_video, 'fallback_url')) {
                return { type: 'video', media: reddit_video.fallback_url };
            }
        }
    }

    if (hasProp(submission, 'preview')) {
        const { preview } = submission;
        if (hasProp(preview, 'reddit_video_preview')) {
            const { reddit_video_preview } = preview;
            if (hasProp(reddit_video_preview, 'fallback_url')) {
                return {
                    type: 'video',
                    media: reddit_video_preview.fallback_url,
                };
            }
        }
    }

    return null;
}

function getExpectedMediaError(expectedSubmission, mediaSubmission, mediaData, galleryExpected) {
    if (isGallerySubmission(expectedSubmission) || galleryExpected) {
        try {
            const imageUrls = getGalleryImageUrls(mediaSubmission, true);
            if (imageUrls.length > 0) {
                return null;
            }
        } catch (error) {
            return error;
        }
        return new Error(
            `Gallery submission ${expectedSubmission.id} (${expectedSubmission.url}) has no gallery images`,
        );
    }

    if (
        expectedSubmission.post_hint === 'image' &&
        (!Array.isArray(mediaData.imageUrls) || mediaData.imageUrls.length === 0)
    ) {
        return new Error(
            `Image submission ${expectedSubmission.id} (${expectedSubmission.url}) has no image media data`,
        );
    }

    if (
        (expectedSubmission.is_video === true ||
            ['hosted:video', 'rich:video'].includes(expectedSubmission.post_hint)) &&
        !mediaData.mediaVideo &&
        !mediaData.mediaHtml
    ) {
        return new Error(
            `Video submission ${expectedSubmission.id} (${expectedSubmission.url}) has no video or embed metadata`,
        );
    }

    return null;
}

function extractSubmissionMedia(submission, galleryExpected = false) {
    const mediaObject = getMedia(submission);
    const isGallery = isGallerySubmission(submission) || galleryExpected;
    const mediaData = {
        imageUrls: isGallery
            ? getGalleryImageUrls(submission, true)
            : mediaObject === null
              ? getSubmissionPreviewImageUrls(submission)
              : [],
        mediaVideo: null,
        mediaHtml: null,
        num_images: isGallery ? submission.gallery_data.items.length : 0,
    };

    if (mediaObject !== null) {
        if (mediaObject.type === 'video') {
            mediaData.mediaVideo = mediaObject.media;
        } else {
            mediaData.mediaHtml = mediaObject.media;
        }
    }

    return mediaData;
}

function cachedMediaSatisfiesExpectedType(submission, cachedSubmission) {
    if (!cachedSubmission) {
        return false;
    }

    const cachedImageUrls = Array.isArray(cachedSubmission.imageUrls) ? cachedSubmission.imageUrls : [];
    const cachedImageCount =
        Number.isInteger(cachedSubmission.num_images) && cachedSubmission.num_images > 0
            ? cachedSubmission.num_images
            : cachedImageUrls.length;
    const galleryItems =
        hasProp(submission, 'gallery_data') && Array.isArray(submission.gallery_data.items)
            ? submission.gallery_data.items
            : null;
    const galleryExpected = isGallerySubmission(submission) || cachedImageCount > 0;

    if (galleryExpected) {
        if (galleryItems !== null) {
            return galleryItems.length > 0 ? cachedImageUrls.length >= galleryItems.length : cachedImageUrls.length > 0;
        }
        return cachedImageCount > 0 && cachedImageUrls.length >= cachedImageCount;
    }
    if (submission.post_hint === 'image') {
        return cachedImageUrls.length > 0;
    }
    if (submission.is_video === true || ['hosted:video', 'rich:video'].includes(submission.post_hint)) {
        return (
            (typeof cachedSubmission.mediaVideo === 'string' && cachedSubmission.mediaVideo.length > 0) ||
            (typeof cachedSubmission.mediaHtml === 'string' && cachedSubmission.mediaHtml.length > 0)
        );
    }
    return true;
}

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

    for (const field of ['mediaVideo', 'mediaHtml']) {
        const hasNewValue = typeof merged[field] === 'string' && merged[field].length > 0;
        const hasCachedValue = typeof cachedSubmission[field] === 'string' && cachedSubmission[field].length > 0;
        if (!hasNewValue && hasCachedValue) {
            merged[field] = cachedSubmission[field];
        }
    }

    const newImageCount = Number.isInteger(merged.num_images) ? merged.num_images : 0;
    const cachedImageCount = Number.isInteger(cachedSubmission.num_images) ? cachedSubmission.num_images : 0;
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
    getExpectedMediaError,
    extractSubmissionMedia,
    cachedMediaSatisfiesExpectedType,
    mergeMediaWithCache,
};
