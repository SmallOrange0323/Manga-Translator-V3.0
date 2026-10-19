import { LOCAL_IMAGE_CHUNK_SIZE } from '../utils/local-manga-upload.js';

// Temporary pixels are intentionally not written to storage. A restarted worker reports an expired upload.
export function createLocalMangaUploads(now = Date.now) {
    const uploads = new Map();
    const lifetime = 5 * 60 * 1000;
    function prune() {
        for (const [id, upload] of uploads) if (upload.expiresAt < now()) uploads.delete(id);
    }
    function get(id) {
        prune();
        const upload = uploads.get(id);
        if (!upload) throw new Error('本地圖片傳送已中斷，請再次按翻譯重試');
        upload.expiresAt = now() + lifetime;
        return upload;
    }
    return {
        begin(images) {
            prune();
            if (!Array.isArray(images) || !images.length || images.some(image => !Number.isSafeInteger(image.length) || image.length < 1)) {
                throw new Error('本地圖片清單不完整，請重新選圖');
            }
            if (uploads.size >= 2) throw new Error('已有本地圖片正在傳送，請稍候再試');
            const id = crypto.randomUUID();
            uploads.set(id, { expiresAt: now() + lifetime,
                images: images.map(image => ({ id: image.id, length: image.length, received: 0, parts: [] })) });
            return id;
        },
        append(id, index, offset, data) {
            const image = get(id).images[index];
            if (!Number.isInteger(index) || !image || image.received !== offset || typeof data !== 'string' ||
                !data.length || data.length > LOCAL_IMAGE_CHUNK_SIZE || offset + data.length > image.length ||
                (offset === 0 && !data.startsWith('data:image/'))) {
                throw new Error('本地圖片傳送順序或資料不完整，請再次按翻譯重試');
            }
            image.parts.push(data);
            image.received += data.length;
        },
        take(id) {
            const upload = get(id);
            if (upload.images.some(image => image.received !== image.length)) throw new Error('本地圖片尚未傳送完成');
            uploads.delete(id);
            return upload.images.map(image => ({ id: image.id, src: image.parts.join('') }));
        },
        cancel(id) { uploads.delete(id); }
    };
}
