import { describe, it, expect } from 'vitest';
import { createGlossaryRefreshGate, createGlossaryTermRow, setGlossaryHeaderFields } from '../src/options/glossary-dom.js';

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.textContent = '';
        this.value = '';
    }

    appendChild(child) { this.children.push(child); }
    append(...children) { this.children.push(...children); }
}

const fakeDocument = { createElement: tagName => new FakeElement(tagName) };

describe('glossary DOM data placement', () => {
    it('keeps markup and quotes in data fields instead of parsed HTML', () => {
        const mangaKey = `book'\"<img src=x onerror=alert(1)>`;
        const ori = `甲'\"<svg onload=alert(2)>`;
        const trans = `譯名 <script>alert(3)</script>`;
        const fields = {
            nameInput: new FakeElement('input'),
            keyText: new FakeElement('code'),
            countText: new FakeElement('span')
        };
        setGlossaryHeaderFields(fields, mangaKey, { displayName: `書名 <b>test</b>` }, 1);
        const row = createGlossaryTermRow({ ori, trans, source: 'user' }, fakeDocument);

        expect(fields.nameInput.value).toBe('書名 <b>test</b>');
        expect(fields.keyText.textContent).toBe(mangaKey);
        expect(row.children[0].children[0].dataset.ori).toBe(ori);
        expect(row.children[1].children[0].value).toBe(ori);
        expect(row.children[1].children[0].dataset.oldOri).toBe(ori);
        expect(row.children[2].children[0].value).toBe(trans);
        expect(row.children[3].children[0].children[0].textContent).toBe('🔒');
        expect(row.children.every(cell => cell.children.length === 1)).toBe(true);
    });
});

describe('glossary detail refresh', () => {
    it('preserves the focused edit and waits for its background write before refreshing', () => {
        let selectedKey = 'manga-a';
        let editing = true;
        const refreshed = [];
        const gate = createGlossaryRefreshGate({
            getSelectedKey: () => selectedKey,
            isEditing: () => editing,
            refresh: key => refreshed.push(key)
        });

        const finishWrite = gate.beginWrite();
        gate.request('manga-a');
        expect(refreshed).toEqual([]);
        editing = false; // The change event has fired, but the write has not returned.
        expect(gate.isBlocked()).toBe(true);
        gate.flush();
        expect(refreshed).toEqual([]);
        finishWrite();
        expect(refreshed).toEqual(['manga-a']);

        editing = true;
        gate.request('manga-a');
        selectedKey = 'manga-b';
        editing = false;
        gate.flush();
        expect(refreshed).toEqual(['manga-a']);
    });
});
