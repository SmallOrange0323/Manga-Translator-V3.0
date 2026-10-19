// Image bytes stay in live contexts; each message remains well below Chrome's 64 MiB limit.
export const LOCAL_IMAGE_CHUNK_SIZE = 2 * 1024 * 1024;

export async function uploadLocalMangaImages(chromeApi, images, options, onProgress = () => {}) {
    async function request(message) {
        const response = await chromeApi.runtime.sendMessage(message);
        if (response?.status !== 'ok') throw new Error(response?.error || '背景服務沒有回應，請重新載入擴充套件');
        return response;
    }
    let uploadId;
    try {
        ({ uploadId } = await request({ action: 'BEGIN_LOCAL_MANGA_UPLOAD',
            images: images.map(image => ({ id: image.id, length: image.src.length })) }));
        for (let index = 0; index < images.length; index++) {
            const src = images[index].src;
            for (let offset = 0; offset < src.length; offset += LOCAL_IMAGE_CHUNK_SIZE) {
                await request({ action: 'APPEND_LOCAL_MANGA_UPLOAD', uploadId, index, offset,
                    data: src.slice(offset, offset + LOCAL_IMAGE_CHUNK_SIZE) });
            }
            onProgress(index + 1, images.length);
        }
        return await request({ action: 'START_MANGA_BATCH_PC_MODE', payload: { ...options, uploadId } });
    } catch (error) {
        if (uploadId) await chromeApi.runtime.sendMessage({ action: 'CANCEL_LOCAL_MANGA_UPLOAD', uploadId }).catch(() => {});
        throw error;
    }
}
