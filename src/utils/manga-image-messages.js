import { LOCAL_IMAGE_CHUNK_SIZE } from './local-manga-upload.js';

export function mangaWireSnapshot(job) {
    if (!job) return job;
    return { ...job, results: job.results.map(row => ({ ...row,
        image: row.image?.startsWith('data:') ? '' : row.image })) };
}

export function* mangaImageMessages(job, rows = job.results) {
    for (const row of rows) {
        if (!row.image?.startsWith('data:')) continue;
        for (let offset = 0; offset < row.image.length; offset += LOCAL_IMAGE_CHUNK_SIZE) {
            yield { action: 'mangaImageChunk', jobId: job.id, revision: job.revision, pageIndex: row.pageIndex,
                offset, length: row.image.length, data: row.image.slice(offset, offset + LOCAL_IMAGE_CHUNK_SIZE) };
        }
    }
}

export function createMangaImageReceiver(getJob, onImage) {
    const pending = new Map();
    let ownerId;
    let ownerRevision;
    return message => {
        const job = getJob();
        if (job?.id !== ownerId || job?.revision !== ownerRevision) {
            pending.clear();
            ownerId = job?.id;
            ownerRevision = job?.revision;
        }
        if (!job || message.jobId !== job.id || message.revision !== job.revision ||
            !Number.isSafeInteger(message.length) || message.length < 1 ||
            !job.results.some(row => row.pageIndex === message.pageIndex)) return;
        let image = pending.get(message.pageIndex);
        if (message.offset === 0) {
            image = { jobId: job.id, revision: job.revision, length: message.length, received: 0, parts: [] };
            pending.set(message.pageIndex, image);
        }
        if (!image || image.jobId !== job.id || image.revision !== job.revision ||
            image.length !== message.length || image.received !== message.offset ||
            typeof message.data !== 'string' || !message.data.length ||
            message.data.length > LOCAL_IMAGE_CHUNK_SIZE || image.received + message.data.length > image.length) return;
        image.parts.push(message.data);
        image.received += message.data.length;
        if (image.received === image.length) {
            pending.delete(message.pageIndex);
            onImage(message.pageIndex, image.parts.join(''));
        }
    };
}
