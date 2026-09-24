import { describe, it, expect } from 'vitest';
import { parseWnacgPageUrls } from '../src/utils/wnacg-parser.js';

describe('Wnacg reader image list', () => {
    it('reads ordered signed URLs from the reader script without executing it', () => {
        const source = '$(document).ready(function(){mReader.initData({'
            + '"page_url":["http://img.example/0001.webp?verify=a%2Fb",'
            + '"http://img.example/0002.webp?verify=bracket]value",],'
            + '"page_size":[[800,1200],[800,1200]]});});';
        expect(parseWnacgPageUrls(source, 'https://www.wnacg.com/photos-slide-aid-123.html')).toEqual([
            'https://img.example/0001.webp?verify=a%2Fb',
            'https://img.example/0002.webp?verify=bracket]value'
        ]);
    });

    it('rejects missing, duplicated, and non-web URLs', () => {
        const base = 'https://www.wnacg.com/photos-slide-aid-123.html';
        expect(() => parseWnacgPageUrls('mReader.initData({});', base)).toThrow();
        expect(() => parseWnacgPageUrls('"page_url":["https://a/1","https://a/1"]', base)).toThrow();
        expect(() => parseWnacgPageUrls('"page_url":["javascript:alert(1)"]', base)).toThrow();
    });
});
