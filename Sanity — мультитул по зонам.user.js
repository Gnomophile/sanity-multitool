// ==UserScript==
// @name         Sanity — мультитул по зонам
// @namespace    starterapp-delivery-zones
// @version      3.1
// @description  Чекбоксы, копирование/вставка зон, массовое редактирование условий доставки
// @match        https://my.starterapp.ru/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Gnomophile/sanity-multitool/main/sanity-multitool.user.js
// @downloadURL  https://raw.githubusercontent.com/Gnomophile/sanity-multitool/main/sanity-multitool.user.js
// ==/UserScript==

(function () {
  'use strict';

  let clipboard   = null;
  let isInjecting = false;

  function newKey() {
    const arr = new Uint8Array(6);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function deepClone(zone) {
    const c = JSON.parse(JSON.stringify(zone));
    c._key = newKey();
    if (Array.isArray(c.deliveryTypePrices)) {
      c.deliveryTypePrices = c.deliveryTypePrices.map(d => {
        const dc = { ...d, _key: newKey() };
        if (Array.isArray(dc.deliveryPrice)) dc.deliveryPrice = dc.deliveryPrice.map(p => ({ ...p, _key: newKey() }));
        return dc;
      });
    }
    return c;
  }

  function getProjectId() {
    const entries = performance.getEntriesByType('resource').map(e => e.name);
    const entry = entries.find(n => n.includes('.api.sanity.io'));
    return entry?.match(/^https?:\/\/([a-z0-9]+)\.api\.sanity\.io/)?.[1] || null;
  }

  function getShopId() {
    return window.location.href.match(/shops-item;shops;([a-f0-9-]{36})/)?.[1] || null;
  }

  function getAuthHeaders(projectId) {
    const tokenData = JSON.parse(localStorage.getItem(`__studio_auth_token_${projectId}`) || 'null');
    if (tokenData?.token) return { 'Authorization': `Bearer ${tokenData.token}` };
    return {};
  }

  async function apiFetch(projectId, path, options = {}) {
    const base = `https://${projectId}.api.sanity.io/v2024-05-28`;
    const headers = { ...getAuthHeaders(projectId), ...(options.headers || {}) };
    return fetch(`${base}${path}`, { ...options, headers, credentials: 'include' });
  }

  async function getDoc(projectId, id) {
    const r = await apiFetch(projectId, `/data/doc/production/drafts.${id},${id}`);
    const { documents } = await r.json();
    return documents.find(d => d._id === `drafts.${id}`) || documents.find(d => d._id === id) || null;
  }

  async function resolveDeliveryTypeNames(projectId, refs) {
    if (!refs.length) return {};
    const r = await apiFetch(projectId, `/data/doc/production/${refs.join(',')}`);
    const { documents } = await r.json();
    const map = {};
    for (const d of documents) map[d._id] = d.name?.ru || d.title?.ru || d._id;
    return map;
  }

  function getAddress(doc) {
    const street = doc.address?.street?.ru || '';
    const house  = doc.address?.house?.ru  || '';
    if (street && house) return `${street}, ${house}`;
    return street || doc.name?.ru || doc._id;
  }

  function showToast(message, type = 'info') {
    const existing = document.getElementById('sz-toast');
    if (existing) existing.remove();
    const colors = { info: '#4a90e2', success: '#27ae60', error: '#e74c3c', warning: '#f39c12' };
    const toast = document.createElement('div');
    toast.id = 'sz-toast';
    toast.style.cssText = `
      position:fixed; bottom:24px; right:24px; z-index:999999;
      background:${colors[type]}; color:#fff;
      padding:12px 18px; border-radius:8px; font-size:14px;
      box-shadow:0 4px 12px rgba(0,0,0,0.2); max-width:360px;
      line-height:1.5; white-space:pre-line; transition:opacity 0.3s;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 5000);
  }

  function updateCopyButtonLabel() {
    const fieldset = document.querySelector('fieldset[data-testid="field-deliveryZones"]');
    if (!fieldset) return;
    const copyBtn = fieldset.querySelector('[data-sz-copy-btn] button');
    if (!copyBtn) return;
    const checkboxes   = Array.from(fieldset.querySelectorAll('input[data-sz-checkbox]'));
    const checkedCount = checkboxes.filter(cb => cb.checked).length;
    if (checkedCount === 0)      copyBtn.textContent = '📋 Копировать все зоны';
    else if (checkedCount === 1) copyBtn.textContent = '📋 Копировать зону';
    else                         copyBtn.textContent = '📋 Копировать зоны';
  }

  function getCheckedZoneNames() {
    const fieldset = document.querySelector('fieldset[data-testid="field-deliveryZones"]');
    if (!fieldset) return null;
    const checkboxes = Array.from(fieldset.querySelectorAll('input[data-sz-checkbox]'));
    const checked = checkboxes.filter(cb => cb.checked).map(cb => cb.getAttribute('data-zone-name'));
    return checked.length > 0 ? checked : null;
  }

  async function onCopy() {
    const projectId = getProjectId();
    const shopId    = getShopId();
    if (!projectId) { showToast('Не удалось определить Project ID', 'error'); return; }
    if (!shopId)    { showToast('Не удалось определить ID заведения', 'error'); return; }
    showToast('Копируем зоны...', 'info');
    try {
      const doc = await getDoc(projectId, shopId);
      if (!doc) { showToast('Заведение не найдено', 'error'); return; }
      const allZones    = doc.deliveryZones || [];
      const zoneNames   = getCheckedZoneNames();
      const zonesToCopy = zoneNames ? allZones.filter(z => zoneNames.includes(z.name)) : allZones;
      if (zonesToCopy.length === 0) { showToast('Нет зон для копирования', 'warning'); return; }
      clipboard = { zones: zonesToCopy, sourceAddress: getAddress(doc) };
      showToast(`✅ Скопировано зон: ${zonesToCopy.length}\n` + zonesToCopy.map(z => `• ${z.name}`).join('\n'), 'success');
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  async function onPaste() {
    if (!clipboard) { showToast('Сначала нажмите «Копировать зоны» на заведении-источнике', 'warning'); return; }
    const projectId = getProjectId();
    const shopId    = getShopId();
    if (!projectId) { showToast('Не удалось определить Project ID', 'error'); return; }
    if (!shopId)    { showToast('Не удалось определить ID заведения', 'error'); return; }
    showToast('Вставляем зоны...', 'info');
    try {
      const targetDoc = await getDoc(projectId, shopId);
      if (!targetDoc) { showToast('Целевое заведение не найдено', 'error'); return; }
      const targetZones = targetDoc.deliveryZones || [];
      const draftId     = 'drafts.' + shopId;
      const hasDraft    = targetDoc._id.startsWith('drafts.');
      const zonesToAdd  = [];
      const skipped     = [];
      for (const zone of clipboard.zones) {
        const newName = `${zone.name} с ${clipboard.sourceAddress}`;
        if (targetZones.find(z => z.name === newName)) { skipped.push(newName); continue; }
        const clone = deepClone(zone);
        clone.name  = newName;
        zonesToAdd.push(clone);
      }
      if (zonesToAdd.length === 0) { showToast('Все выбранные зоны уже есть в этом заведении', 'warning'); return; }
      const mutations = [];
      if (!hasDraft) {
        const { documents } = await (await apiFetch(projectId, `/data/doc/production/${shopId}`)).json();
        mutations.push({ createIfNotExists: { ...documents[0], _id: draftId } });
      }
      mutations.push({
        patch: {
          id: draftId,
          setIfMissing: { deliveryZones: [] },
          insert: { after: 'deliveryZones[-1]', items: zonesToAdd }
        }
      });
      const r = await apiFetch(projectId, `/data/mutate/production`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations })
      });
      const result = await r.json();
      if (r.ok) {
        let msg = `✅ Вставлено зон: ${zonesToAdd.length}\n` + zonesToAdd.map(z => `• ${z.name}`).join('\n');
        if (skipped.length) msg += `\n\n⚠️ Пропущено (уже есть): ${skipped.length}`;
        msg += '\n\nНажмите «Опубликовать» в интерфейсе';
        showToast(msg, 'success');
      } else {
        showToast('Ошибка Sanity: ' + JSON.stringify(result?.error || result), 'error');
      }
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }
    function buildGradationEditor(rows) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:6px;';
    const table = document.createElement('div');
    table.setAttribute('data-sz-grad-table', '1');
    table.style.cssText = 'display:flex; flex-direction:column; gap:4px;';

    function addRow(basketPriceTo = '', price = '') {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:6px; align-items:center;';
      row.innerHTML = `
        <span style="font-size:12px;color:#888;white-space:nowrap;">до ₽</span>
        <input type="number" placeholder="сумма корзины" value="${basketPriceTo}"
          style="width:110px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:13px;"
          data-sz-grad-to>
        <span style="font-size:12px;color:#888;">→ ₽</span>
        <input type="number" placeholder="цена" value="${price}"
          style="width:90px;padding:4px 6px;border:1px solid #ccc;border-radius:4px;font-size:13px;"
          data-sz-grad-price>
        <button type="button" style="padding:2px 8px;border:none;background:#e74c3c;color:#fff;border-radius:4px;cursor:pointer;font-size:13px;" data-sz-grad-del>✕</button>
      `;
      row.querySelector('[data-sz-grad-del]').addEventListener('click', () => row.remove());
      table.appendChild(row);
    }

    for (const r of rows) addRow(r.basketPriceTo, r.price);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = '+ Добавить ступень';
    addBtn.style.cssText = 'margin-top:4px;padding:4px 10px;border:1px dashed #4a90e2;background:transparent;color:#4a90e2;border-radius:4px;cursor:pointer;font-size:12px;';
    addBtn.addEventListener('click', () => addRow());

    wrap.appendChild(table);
    wrap.appendChild(addBtn);
    return wrap;
  }

  function readGradation(container) {
    const rows = container.querySelectorAll('[data-sz-grad-table] > div');
    const result = [];
    for (const row of rows) {
      const to    = parseFloat(row.querySelector('[data-sz-grad-to]').value);
      const price = parseFloat(row.querySelector('[data-sz-grad-price]').value);
      if (!isNaN(to) && !isNaN(price)) result.push({ _key: newKey(), _type: 'deliveryPrice', basketPriceTo: to, price });
    }
    return result;
  }

  function buildDeliveryTypeSection(label, dtpData, isCollapsed) {
    const section = document.createElement('div');
    section.style.cssText = 'margin-top:10px;';
    const existingTime = dtpData?.deliveryTime  ?? '';
    const existingMin  = dtpData?.minBasketPrice ?? '';
    const existingDef  = dtpData?.defaultDeliveryPrice ?? '';
    const existingGrad = dtpData?.deliveryPrice || [];

    const content = document.createElement('div');
    content.setAttribute('data-sz-section', label);
    content.style.cssText = 'padding:10px;background:#f8f9fa;border-radius:6px;border:1px solid #e0e0e0;';
    content.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
        <label style="font-size:12px;color:#555;">Время доставки (мин)
          <input type="number" placeholder="не менять" value="${existingTime}"
            style="display:block;width:100%;margin-top:3px;padding:5px 7px;border:1px solid #ccc;border-radius:4px;font-size:13px;box-sizing:border-box;"
            data-sz-field="deliveryTime">
        </label>
        <label style="font-size:12px;color:#555;">Мин. сумма корзины
          <input type="number" placeholder="не менять" value="${existingMin}"
            style="display:block;width:100%;margin-top:3px;padding:5px 7px;border:1px solid #ccc;border-radius:4px;font-size:13px;box-sizing:border-box;"
            data-sz-field="minBasketPrice">
        </label>
        <label style="font-size:12px;color:#555;">Цена по умолчанию
          <input type="number" placeholder="не менять" value="${existingDef}"
            style="display:block;width:100%;margin-top:3px;padding:5px 7px;border:1px solid #ccc;border-radius:4px;font-size:13px;box-sizing:border-box;"
            data-sz-field="defaultDeliveryPrice">
        </label>
      </div>
      <div style="font-size:12px;color:#555;margin-bottom:4px;">Градация цен <span style="color:#888;">(пустая таблица = очистить, не трогайте если не нужно менять)</span></div>
    `;
    const gradWrap = document.createElement('div');
    gradWrap.setAttribute('data-sz-grad-wrap', '1');
    gradWrap.appendChild(buildGradationEditor(existingGrad));
    content.appendChild(gradWrap);

    if (isCollapsed) {
      const details = document.createElement('details');
      details.style.cssText = 'margin-top:10px;';
      const summary = document.createElement('summary');
      summary.style.cssText = 'cursor:pointer;font-size:13px;font-weight:600;color:#555;user-select:none;';
      summary.textContent = label;
      details.appendChild(summary);
      details.appendChild(content);
      section.appendChild(details);
    } else {
      const titleEl = document.createElement('div');
      titleEl.style.cssText = 'font-size:13px;font-weight:700;color:#333;margin-bottom:6px;';
      titleEl.textContent = label;
      section.appendChild(titleEl);
      section.appendChild(content);
    }
    return section;
  }

  async function onEditConditions() {
    const projectId = getProjectId();
    const shopId    = getShopId();
    if (!projectId) { showToast('Не удалось определить Project ID', 'error'); return; }
    if (!shopId)    { showToast('Не удалось определить ID заведения', 'error'); return; }
    showToast('Загружаем данные...', 'info');
    let doc, typeNameMap;
    try {
      doc = await getDoc(projectId, shopId);
      if (!doc) { showToast('Заведение не найдено', 'error'); return; }
      const allRefs = new Set();
      for (const zone of (doc.deliveryZones || []))
        for (const dtp of (zone.deliveryTypePrices || []))
          if (dtp.deliveryType?._ref) allRefs.add(dtp.deliveryType._ref);
      typeNameMap = await resolveDeliveryTypeNames(projectId, [...allRefs]);
    } catch (e) {
      showToast('Ошибка загрузки: ' + e.message, 'error'); return;
    }

    const zoneNames   = getCheckedZoneNames();
    const targetZones = zoneNames
      ? (doc.deliveryZones || []).filter(z => zoneNames.includes(z.name))
      : (doc.deliveryZones || []);
    if (targetZones.length === 0) { showToast('Нет зон для редактирования', 'warning'); return; }

    const firstZone = targetZones[0];
    const dtpByName = {};
    for (const dtp of (firstZone.deliveryTypePrices || [])) {
      const name = typeNameMap[dtp.deliveryType?._ref];
      if (name) dtpByName[name] = dtp;
    }

    const allTypeNames = [...new Set(Object.values(typeNameMap))].sort((a, b) => {
      if (a === 'Доставка') return -1;
      if (b === 'Доставка') return 1;
      return a.localeCompare(b, 'ru');
    });

    const overlay = document.createElement('div');
    overlay.id = 'sz-edit-modal';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:999998;
      background:rgba(0,0,0,0.45);
      display:flex;align-items:center;justify-content:center;
    `;
    const modal = document.createElement('div');
    modal.style.cssText = `
      background:#fff;border-radius:10px;padding:24px;
      width:560px;max-width:95vw;max-height:85vh;
      overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.25);
      position:relative;
    `;
    const title = document.createElement('div');
    title.style.cssText = 'font-size:16px;font-weight:700;margin-bottom:4px;';
    title.textContent = '✏️ Изменить условия доставки';
    const subtitle = document.createElement('div');
    subtitle.style.cssText = 'font-size:12px;color:#888;margin-bottom:14px;';
    subtitle.textContent = `Зоны: ${targetZones.map(z => z.name).join(', ')}`;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:14px;right:16px;background:none;border:none;font-size:18px;cursor:pointer;color:#999;';
    closeBtn.addEventListener('click', () => overlay.remove());

    modal.appendChild(closeBtn);
    modal.appendChild(title);
    modal.appendChild(subtitle);

    for (let i = 0; i < allTypeNames.length; i++) {
      modal.appendChild(buildDeliveryTypeSection(allTypeNames[i], dtpByName[allTypeNames[i]] || null, allTypeNames[i] !== 'Доставка'));
    }

    const applyBtn = document.createElement('button');
    applyBtn.textContent = '✅ Применить';
    applyBtn.style.cssText = `
      margin-top:18px;width:100%;padding:12px;
      background:#4a90e2;color:#fff;border:none;border-radius:6px;
      font-size:14px;font-weight:700;cursor:pointer;
    `;
    applyBtn.addEventListener('click', () => applyConditions(overlay, modal, projectId, shopId, doc, targetZones, typeNameMap, allTypeNames));
    modal.appendChild(applyBtn);
    overlay.appendChild(modal);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  async function applyConditions(overlay, modal, projectId, shopId, doc, targetZones, typeNameMap, allTypeNames) {
    const changes = {};
    for (const typeName of allTypeNames) {
      const section = modal.querySelector(`[data-sz-section="${typeName}"]`);
      if (!section) continue;
      const timeVal = section.querySelector('[data-sz-field="deliveryTime"]')?.value.trim();
      const minVal  = section.querySelector('[data-sz-field="minBasketPrice"]')?.value.trim();
      const defVal  = section.querySelector('[data-sz-field="defaultDeliveryPrice"]')?.value.trim();
      const gradWrap = section.querySelector('[data-sz-grad-wrap]');
      const entry = {};
      if (timeVal !== '') entry.deliveryTime = parseFloat(timeVal);
      if (minVal  !== '') entry.minBasketPrice = parseFloat(minVal);
      if (defVal  !== '') entry.defaultDeliveryPrice = parseFloat(defVal);
      if (gradWrap) entry.deliveryPrice = readGradation(gradWrap);
      if (Object.keys(entry).length > 0) changes[typeName] = entry;
    }
    if (Object.keys(changes).length === 0) { showToast('Нет изменений для применения', 'warning'); return; }

    const draftId  = 'drafts.' + shopId;
    const hasDraft = doc._id.startsWith('drafts.');
    const mutations = [];
    if (!hasDraft) {
      const { documents } = await (await apiFetch(projectId, `/data/doc/production/${shopId}`)).json();
      mutations.push({ createIfNotExists: { ...documents[0], _id: draftId } });
    }

    for (const zone of targetZones) {
      for (const dtp of (zone.deliveryTypePrices || [])) {
        const typeName = typeNameMap[dtp.deliveryType?._ref];
        const change   = changes[typeName];
        if (!change) continue;
        const path = `deliveryZones[_key=="${zone._key}"].deliveryTypePrices[_key=="${dtp._key}"]`;
        const setFields = {};
        if ('deliveryTime'         in change) setFields[`${path}.deliveryTime`]         = change.deliveryTime;
        if ('minBasketPrice'       in change) setFields[`${path}.minBasketPrice`]       = change.minBasketPrice;
        if ('defaultDeliveryPrice' in change) setFields[`${path}.defaultDeliveryPrice`] = change.defaultDeliveryPrice;
        if ('deliveryPrice'        in change) setFields[`${path}.deliveryPrice`]        = change.deliveryPrice;
        if (Object.keys(setFields).length > 0) mutations.push({ patch: { id: draftId, set: setFields } });
      }
    }

    if (mutations.length === 0) { showToast('Не найдены совпадающие типы доставки в зонах', 'warning'); return; }

    overlay.remove();
    showToast('Применяем изменения...', 'info');
    try {
      const r = await apiFetch(projectId, `/data/mutate/production`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations })
      });
      const result = await r.json();
      if (r.ok) {
        showToast(`✅ Условия обновлены в ${targetZones.length} зон(ах):\n` + Object.keys(changes).map(t => `• ${t}`).join('\n') + '\n\nНажмите «Опубликовать»', 'success');
      } else {
        showToast('Ошибка Sanity: ' + JSON.stringify(result?.error || result), 'error');
      }
    } catch (e) {
      showToast('Ошибка: ' + e.message, 'error');
    }
  }

  function createButton(text, color, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = `
      flex:1; padding:10px 14px; background:${color}; color:#fff;
      border:none; border-radius:6px; font-size:13px; font-weight:600;
      cursor:pointer; transition:opacity 0.2s; white-space:nowrap;
    `;
    btn.addEventListener('mouseenter', () => btn.style.opacity = '0.85');
    btn.addEventListener('mouseleave', () => btn.style.opacity = '1');
    btn.addEventListener('click', onClick);
    return btn;
  }

  function addCheckboxToZoneItem(preview) {
    let flex = preview;
    for (let i = 0; i < 4; i++) flex = flex.parentElement;
    if (!flex || flex.getAttribute('data-ui') !== 'Flex') return;
    if (flex.getAttribute('data-sz-zone') === 'marked') return;
    const header   = preview.querySelector('[data-testid="default-preview__header"]');
    const zoneName = header?.querySelector('span')?.textContent.trim() || '';
    if (!zoneName) return;
    const rightFlex = flex.children[2];
    if (!rightFlex) return;
    const label = document.createElement('label');
    label.title = 'Выбрать для копирования / редактирования';
    label.style.cssText = 'display:flex; align-items:center; cursor:pointer; padding:0 6px;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.setAttribute('data-sz-checkbox', 'true');
    cb.setAttribute('data-zone-name', zoneName);
    cb.style.cssText = 'width:16px; height:16px; cursor:pointer; accent-color:#4a90e2; flex-shrink:0;';
    cb.addEventListener('click', e => e.stopPropagation());
    cb.addEventListener('change', updateCopyButtonLabel);
    label.appendChild(cb);
    rightFlex.insertBefore(label, rightFlex.firstChild);
    flex.setAttribute('data-sz-zone', 'marked');
  }

  function inject() {
    if (isInjecting) return;
    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
    if (activeTab?.textContent.trim() !== 'Доставка') return;
    const fieldset = document.querySelector('fieldset[data-testid="field-deliveryZones"]');
    if (!fieldset) return;
    const previews   = fieldset.querySelectorAll('[data-testid="default-preview"]');
    const hasButtons = !!fieldset.querySelector('[data-sz-wrapper]');
    const allHaveCb  = Array.from(previews).every(p => {
      let flex = p;
      for (let i = 0; i < 4; i++) flex = flex.parentElement;
      return flex?.getAttribute('data-sz-zone') === 'marked';
    });
    if (hasButtons && allHaveCb) return;
    isInjecting = true;
    observer.disconnect();
    try {
      previews.forEach(p => addCheckboxToZoneItem(p));
      if (!hasButtons) {
        const addBtn = fieldset.querySelector('button[data-testid="add-single-object-button"]');
        if (addBtn) {
          const stack = addBtn.parentElement?.parentElement;
          if (stack) {
            fieldset.querySelector('[data-sz-btn]')?.remove();
            const wrapper = document.createElement('div');
            wrapper.setAttribute('data-sz-btn', 'true');
            wrapper.setAttribute('data-sz-wrapper', 'true');
            wrapper.style.cssText = 'margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;';
            const copyWrap = document.createElement('span');
            copyWrap.setAttribute('data-sz-copy-btn', 'true');
            copyWrap.style.cssText = 'flex:1;display:flex;';
            copyWrap.appendChild(createButton('📋 Копировать все зоны', '#4a90e2', onCopy));
            wrapper.appendChild(copyWrap);
            wrapper.appendChild(createButton('📌 Вставить зоны', '#27ae60', onPaste));
            wrapper.appendChild(createButton('✏️ Условия',       '#8e44ad', onEditConditions));
            stack.appendChild(wrapper);
          }
        }
      }
    } finally {
      isInjecting = false;
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(inject, 150);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  inject();

})();