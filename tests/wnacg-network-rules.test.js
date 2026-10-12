import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
const ruleset = manifest.declarative_net_request.rule_resources.find(r => r.id === 'wnacg_local_jquery');
const rules = JSON.parse(readFileSync(new URL(`../public/${ruleset.path}`, import.meta.url)));
const dependencies = [
    { id: 1, upstream: 'jquery/jquery-1.10.2.min.js', file: 'jquery-1.10.2.min.js',
        sha256: '0ba081f546084bd5097aa8a73c75931d5aa1fc4d6e846e53c21f98e6a1509988', license: 'jquery-MIT-LICENSE.txt' },
    { id: 2, upstream: 'jquery/jquery-1.6.2.min.js', file: 'jquery-1.6.2.min.js',
        sha256: 'd16d07a0353405fcec95f7efc50a2621bc7425f9a5e8895078396fb0dc460c4f', license: 'jquery-1.6.2-MIT-LICENSE.txt' },
    { id: 3, upstream: 'jqueryui/jquery.ui-1.8.24.min.js', file: 'jquery-ui-1.8.24.min.js',
        sha256: '50ea31c0452a869e41485170ab3ca8d90a7824b99860f4c707c97ed728598a3f', license: 'jquery-ui-1.8.24-MIT-LICENSE.txt' }
];

describe('WNACG blocking CDN replacement', () => {
    it('enables one static ruleset with unique rule IDs for all observed dependencies', () => {
        expect(ruleset.enabled).toBe(true);
        expect(manifest.permissions).toContain('declarativeNetRequestWithHostAccess');
        expect(rules.map(r => r.id)).toEqual(dependencies.map(d => d.id));
    });

    describe.each(dependencies)('$file', dependency => {
        const rule = rules.find(r => r.id === dependency.id);
        const pattern = new RegExp(rule.condition.regexFilter);
        const url = `https://upcdn.b0.upaiyun.com/libs/${dependency.upstream}`;

        it('matches the exact observed version with HTTP and cache query parameters', () => {
            expect(pattern.test(url)).toBe(true);
            expect(pattern.test(url.replace('https:', 'http:') + '?v=1')).toBe(true);
            for (const other of dependencies.filter(d => d.id !== dependency.id)) {
                expect(pattern.test(`https://upcdn.b0.upaiyun.com/libs/${other.upstream}`)).toBe(false);
            }
        });

        it('excludes other versions, file suffixes, and lookalike domains', () => {
            for (const invalid of [
                'https://upcdn.b0.upaiyun.com/libs/jquery/jquery-3.7.1.min.js',
                url + '.map',
                url.replace('upaiyun.com/', 'upaiyun.com.evil.example/'),
                'https://other.example/?url=' + url
            ]) expect(pattern.test(invalid)).toBe(false);
            expect(rule.condition.initiatorDomains).toEqual(['wnacg.com']);
            expect(rule.condition.resourceTypes).toEqual(['script']);
        });

        it('ships the original same-version file, license, and site-scoped redirect target', () => {
            const path = `vendor/${dependency.file}`;
            expect(rule.action).toEqual({ type: 'redirect', redirect: { extensionPath: `/${path}` } });
            const bytes = readFileSync(new URL(`../public/${path}`, import.meta.url));
            expect(createHash('sha256').update(bytes).digest('hex')).toBe(dependency.sha256);
            const entry = manifest.web_accessible_resources.find(r => r.resources.includes(path));
            expect(entry.matches).toEqual(['*://*.wnacg.com/*']);
            expect(existsSync(new URL(`../public/vendor/${dependency.license}`, import.meta.url))).toBe(true);
        });
    });
});
