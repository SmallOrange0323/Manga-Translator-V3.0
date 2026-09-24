// Keep glossary data out of HTML strings. Terms and work names may contain markup or quotes.
export function setGlossaryHeaderFields(fields, mangaKey, entry, termCount) {
    fields.nameInput.value = entry.displayName || mangaKey;
    fields.keyText.textContent = mangaKey;
    fields.countText.textContent = String(termCount);
}

export function createGlossaryTermRow(term, doc = document) {
    const tr = doc.createElement('tr');
    const checkboxCell = doc.createElement('td');
    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'term-checkbox';
    checkbox.dataset.ori = term.ori;
    checkboxCell.appendChild(checkbox);

    const makeInputCell = (field, value) => {
        const cell = doc.createElement('td');
        const input = doc.createElement('input');
        input.type = 'text';
        input.className = 'term-input';
        input.dataset.field = field;
        input.value = value;
        if (field === 'ori') input.dataset.oldOri = value;
        cell.appendChild(input);
        return cell;
    };

    const actionsCell = doc.createElement('td');
    const actions = doc.createElement('div');
    actions.className = 'action-btns';
    const badge = doc.createElement('span');
    badge.className = `badge ${term.source === 'user' ? 'badge-user' : 'badge-ai'}`;
    badge.title = term.source === 'user' ? '使用者手動修改' : 'AI 自動學習';
    badge.textContent = term.source === 'user' ? '🔒' : '🤖';
    const tick = doc.createElement('span');
    tick.className = 'save-tick';
    tick.style.display = 'none';
    tick.style.color = 'green';
    tick.textContent = '✅ 儲存';
    const deleteButton = doc.createElement('button');
    deleteButton.className = 'btn-small btn-danger delete-term-btn';
    deleteButton.textContent = '✕';
    actions.append(badge, tick, deleteButton);
    actionsCell.appendChild(actions);
    tr.append(checkboxCell, makeInputCell('ori', term.ori), makeInputCell('trans', term.trans), actionsCell);
    return tr;
}

// Background glossary broadcasts can arrive while an input has unsaved text.
// Refresh the detail pane only after editing and its write have finished.
export function createGlossaryRefreshGate({ getSelectedKey, isEditing, refresh }) {
    let pendingKey = null;
    let activeWrites = 0;

    const isBlocked = () => activeWrites > 0 || isEditing();

    const flush = () => {
        if (pendingKey === null) return;
        if (pendingKey !== getSelectedKey()) {
            pendingKey = null;
            return;
        }
        if (isBlocked()) return;
        const key = pendingKey;
        pendingKey = null;
        refresh(key);
    };

    return {
        request(key) {
            if (key !== getSelectedKey()) return;
            pendingKey = key;
            flush();
        },
        flush,
        isBlocked,
        beginWrite() {
            activeWrites++;
            let finished = false;
            return () => {
                if (finished) return;
                finished = true;
                activeWrites--;
                flush();
            };
        }
    };
}
