/* Niche workspace UI and IndexedDB persistence. All processing stays in this browser. */
(function () {
  'use strict';

  const DB_NAME = 'amazonNicheWorkspace';
  const DB_VERSION = 1;
  const $ = function (id) { return document.getElementById(id); };
  const state = {
    db: null,
    products: [],
    niches: [],
    activeProductId: '',
    selectedNicheId: ''
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function setStatus(id, message, kind) {
    const element = $(id);
    if (!element) return;
    element.textContent = message;
    element.className = 'notice' + (kind ? ' ' + kind : '');
  }

  function openDatabase() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) {
        reject(new Error('当前浏览器不支持本地数据存储，请使用最新版 Chrome 或 Edge。'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        const db = request.result;
        if (!db.objectStoreNames.contains('products')) {
          db.createObjectStore('products', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('niches')) {
          const store = db.createObjectStore('niches', { keyPath: 'id' });
          store.createIndex('productId', 'productId', { unique: false });
        }
      };
      request.onsuccess = function () {
        const db = request.result;
        db.onversionchange = function () { db.close(); };
        resolve(db);
      };
      request.onerror = function () {
        reject(request.error || new Error('无法打开本地 Niche 数据库。'));
      };
    });
  }

  function readAll(storeName) {
    return new Promise(function (resolve, reject) {
      const request = state.db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = function () { resolve(request.result || []); };
      request.onerror = function () { reject(request.error || new Error('读取本地数据失败。')); };
    });
  }

  function saveRecord(storeName, record) {
    return new Promise(function (resolve, reject) {
      const transaction = state.db.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).put(record);
      transaction.oncomplete = function () { resolve(record); };
      transaction.onerror = function () { reject(transaction.error || new Error('保存数据失败。')); };
      transaction.onabort = function () { reject(transaction.error || new Error('保存操作已取消。')); };
    });
  }

  function deleteRecord(storeName, id) {
    return new Promise(function (resolve, reject) {
      const transaction = state.db.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(id);
      transaction.oncomplete = resolve;
      transaction.onerror = function () { reject(transaction.error || new Error('删除数据失败。')); };
    });
  }

  function deleteProductAndNiches(productId) {
    return new Promise(function (resolve, reject) {
      const transaction = state.db.transaction(['products', 'niches'], 'readwrite');
      transaction.objectStore('products').delete(productId);
      state.niches.filter(function (niche) {
        return niche.productId === productId;
      }).forEach(function (niche) {
        transaction.objectStore('niches').delete(niche.id);
      });
      transaction.oncomplete = resolve;
      transaction.onerror = function () { reject(transaction.error || new Error('删除产品及其 Niche 数据失败。')); };
    });
  }

  function activeProduct() {
    return state.products.find(function (product) {
      return product.id === state.activeProductId;
    }) || null;
  }

  function productNiches() {
    return state.niches.filter(function (niche) {
      return niche.productId === state.activeProductId;
    }).sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
  }

  function formatNumber(value, digits) {
    if (value == null || !Number.isFinite(Number(value))) return '—';
    return new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits || 0,
      maximumFractionDigits: digits == null ? 0 : digits
    }).format(Number(value));
  }

  function formatPercent(value) {
    return value == null || !Number.isFinite(Number(value))
      ? '—'
      : (Number(value) * 100).toFixed(2) + '%';
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN');
  }

  function cell(row, value, className) {
    const td = document.createElement('td');
    td.textContent = value == null ? '' : String(value);
    if (className) td.className = className;
    row.appendChild(td);
    return td;
  }

  function button(label, className, handler) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (className) element.className = className;
    element.addEventListener('click', handler);
    return element;
  }

  function renderProductSelect() {
    const select = $('productSelect');
    const previous = state.activeProductId;
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = state.products.length ? '请选择要管理的产品' : '请先添加产品';
    select.appendChild(placeholder);

    state.products.forEach(function (product) {
      const count = state.niches.filter(function (niche) {
        return niche.productId === product.id;
      }).length;
      const option = document.createElement('option');
      option.value = product.id;
      option.textContent = product.name + '（' + count + ' 个 Niche）';
      select.appendChild(option);
    });

    if (state.products.some(function (product) { return product.id === previous; })) {
      select.value = previous;
    } else if (state.products.length) {
      state.activeProductId = state.products[0].id;
      select.value = state.activeProductId;
    } else {
      state.activeProductId = '';
    }
  }

  function renderProductsTable() {
    const host = $('productsTable');
    host.innerHTML = '';
    if (!state.products.length) {
      host.textContent = '还没有产品。请先在上方添加一个产品。';
      return;
    }

    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = '<thead><tr><th>产品名称</th><th>Niche 数量</th><th>最近更新</th><th>操作</th></tr></thead><tbody></tbody>';
    const body = table.querySelector('tbody');

    state.products.forEach(function (product) {
      const related = state.niches.filter(function (niche) {
        return niche.productId === product.id;
      });
      const latest = related.reduce(function (max, niche) {
        const value = niche.updatedAt || niche.createdAt || '';
        return value > max ? value : max;
      }, product.updatedAt || product.createdAt || '');
      const tr = document.createElement('tr');
      cell(tr, product.name);
      cell(tr, String(related.length));
      cell(tr, formatDate(latest));
      const actions = document.createElement('td');
      actions.appendChild(button('选择', 'small-button', function () {
        state.activeProductId = product.id;
        state.selectedNicheId = '';
        renderAll();
      }));
      actions.appendChild(button('删除产品', 'small-button danger', async function () {
        const message = '确定删除产品「' + product.name + '」及其全部 ' + related.length + ' 个 Niche 吗？此操作无法撤销。';
        if (!window.confirm(message)) return;
        try {
          await deleteProductAndNiches(product.id);
          if (state.activeProductId === product.id) state.activeProductId = '';
          state.selectedNicheId = '';
          await refreshData();
          setStatus('productStatus', '产品及其 Niche 数据已删除。');
        } catch (error) {
          setStatus('productStatus', error.message, 'error');
        }
      }));
      tr.appendChild(actions);
      if (product.id === state.activeProductId) tr.classList.add('selected-row');
      body.appendChild(tr);
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrap';
    wrapper.appendChild(table);
    host.appendChild(wrapper);
  }

  function renderNichesTable() {
    const host = $('nichesTable');
    const product = activeProduct();
    host.innerHTML = '';
    $('downloadWorkbook').disabled = !product || productNiches().length === 0;

    if (!product) {
      host.textContent = '请先选择或添加一个产品。';
      $('activeProductLabel').textContent = '尚未选择产品';
      return;
    }

    $('activeProductLabel').textContent = product.name;
    const niches = productNiches();
    if (!niches.length) {
      host.textContent = '这个产品还没有 Niche。上传 Product CSV 和 Search Term CSV 后，会在这里显示。';
      return;
    }

    const table = document.createElement('table');
    table.className = 'data-table';
    table.innerHTML = '<thead><tr><th>Niche 市场</th><th>搜索词数</th><th>Total Clicks</th><th>Total Orders</th><th>整体 CVR</th><th>更新时间</th><th>操作</th></tr></thead><tbody></tbody>';
    const body = table.querySelector('tbody');

    niches.forEach(function (niche) {
      const tr = document.createElement('tr');
      cell(tr, niche.name);
      cell(tr, formatNumber(niche.searchTermCount));
      cell(tr, formatNumber(niche.totalClicks));
      cell(tr, formatNumber(niche.totalOrders, 2));
      cell(tr, formatPercent(niche.overallCvr));
      cell(tr, formatDate(niche.updatedAt));
      const actions = document.createElement('td');
      actions.appendChild(button('查看', 'small-button', function () {
        state.selectedNicheId = niche.id;
        renderPreview();
      }));
      actions.appendChild(button('删除', 'small-button danger', async function () {
        if (!window.confirm('确定删除 Niche「' + niche.name + '」吗？其他 Niche 不受影响。')) return;
        try {
          await deleteRecord('niches', niche.id);
          if (state.selectedNicheId === niche.id) state.selectedNicheId = '';
          await refreshData();
          setStatus('nicheStatus', 'Niche「' + niche.name + '」已删除，其他 Niche 保留。');
        } catch (error) {
          setStatus('nicheStatus', error.message, 'error');
        }
      }));
      tr.appendChild(actions);
      body.appendChild(tr);
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrap';
    wrapper.appendChild(table);
    host.appendChild(wrapper);
  }

  function renderPreview() {
    const host = $('previewContent');
    const niche = state.niches.find(function (item) {
      return item.id === state.selectedNicheId && item.productId === state.activeProductId;
    });
    host.innerHTML = '';
    if (!niche) {
      $('previewTitle').textContent = '数据预览';
      host.textContent = '选择上方某个 Niche 的「查看」即可预览计算结果。';
      return;
    }

    $('previewTitle').textContent = '数据预览｜' + niche.name;
    const metrics = document.createElement('div');
    metrics.className = 'metric-grid';
    [
      ['Total Clicks', formatNumber(niche.totalClicks)],
      ['Total Orders', formatNumber(niche.totalOrders, 2)],
      ['Overall CVR', formatPercent(niche.overallCvr)]
    ].forEach(function (item) {
      const card = document.createElement('div');
      card.className = 'metric-card';
      const label = document.createElement('span');
      label.textContent = item[0];
      const value = document.createElement('strong');
      value.textContent = item[1];
      card.append(label, value);
      metrics.appendChild(card);
    });
    host.appendChild(metrics);

    const table = document.createElement('table');
    table.className = 'data-table preview-table';
    const extraIndexes = Array.isArray(niche.searchTermExtraIndexes)
      ? niche.searchTermExtraIndexes
      : [];
    const sourceHeaders = Array.isArray(niche.searchTermHeaders)
      ? niche.searchTermHeaders
      : [];
    const previewHeaders = [
      '搜索词',
      '搜索量（过去 360 天）',
      'CVR',
      'Clicks',
      'Orders%',
      'Orders'
    ].concat(extraIndexes.map(function (sourceIndex) {
      return sourceHeaders[sourceIndex] || ('原始 ST 字段 ' + (sourceIndex + 1));
    }));
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    previewHeaders.forEach(function (header) {
      const th = document.createElement('th');
      th.textContent = header;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    const body = document.createElement('tbody');

    (niche.rows || []).forEach(function (item) {
      const tr = document.createElement('tr');
      cell(tr, item.term);
      cell(tr, formatNumber(item.searchVolume));
      cell(tr, formatPercent(item.cvr));
      cell(tr, formatNumber(item.clicks, 2));
      cell(tr, formatPercent(item.ordersPct));
      cell(tr, formatNumber(item.orders, 2));
      const originalValues = Array.isArray(item.sourceValues) ? item.sourceValues : [];
      extraIndexes.forEach(function (sourceIndex) {
        cell(tr, originalValues[sourceIndex] == null ? '' : originalValues[sourceIndex]);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);

    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrap';
    wrapper.appendChild(table);
    host.appendChild(wrapper);
    const foot = document.createElement('p');
    foot.className = 'muted';
    foot.textContent = '来源文件：' + (niche.productFileName || 'Product CSV') + ' / ' +
      (niche.searchTermFileName || 'Search Term CSV') + '；商品数 ' +
      formatNumber(niche.productCount) + '，搜索词数 ' + formatNumber(niche.searchTermCount) + '。';
    host.appendChild(foot);
    if (!Array.isArray(niche.searchTermHeaders) || !niche.searchTermHeaders.length) {
      const legacyNote = document.createElement('p');
      legacyNote.className = 'muted';
      legacyNote.textContent = '这条 Niche 是旧版保存的数据，尚未保存原始 ST 表的其他字段。若要补齐这些字段，请重新上传该 Niche 的 Product CSV 和 Search Term CSV。';
      host.appendChild(legacyNote);
    }
  }

  function renderAll() {
    renderProductSelect();
    renderProductsTable();
    renderNichesTable();
    renderPreview();
  }

  async function refreshData() {
    const results = await Promise.all([readAll('products'), readAll('niches')]);
    state.products = results[0].sort(function (a, b) {
      return String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
    });
    state.niches = results[1];
    renderAll();
  }

  async function addProduct() {
    const input = $('newProductName');
    const name = String(input.value || '').trim();
    if (!name) {
      setStatus('productStatus', '请先填写产品名称。', 'warn');
      return;
    }
    const existing = state.products.find(function (product) {
      return String(product.name || '').trim().toLocaleLowerCase() === name.toLocaleLowerCase();
    });
    if (existing) {
      state.activeProductId = existing.id;
      renderAll();
      setStatus('productStatus', '产品「' + existing.name + '」已经存在，已为你选中。', 'warn');
      return;
    }

    const now = new Date().toISOString();
    const record = { id: uid(), name: name, createdAt: now, updatedAt: now };
    try {
      await saveRecord('products', record);
      state.activeProductId = record.id;
      state.selectedNicheId = '';
      input.value = '';
      await refreshData();
      setStatus('productStatus', '已添加产品「' + name + '」。现在可以为它添加多个 Niche。');
    } catch (error) {
      setStatus('productStatus', error.message, 'error');
    }
  }

  async function autoFillNicheName(file) {
    if (!file || String($('nicheName').value || '').trim()) return;
    try {
      const name = NicheEngine.extractNicheName(await file.text());
      if (name) $('nicheName').value = name;
    } catch (_) {
      /* The full validation runs when both CSV files are submitted. */
    }
  }

  async function saveNiche() {
    const product = activeProduct();
    const productFile = $('productCsv').files[0];
    const searchFile = $('searchTermCsv').files[0];
    if (!product) {
      setStatus('nicheStatus', '请先选择一个产品。', 'error');
      return;
    }
    if (!productFile || !searchFile) {
      setStatus('nicheStatus', '请同时上传 Product CSV 和 Search Term CSV。', 'error');
      return;
    }
    if (!/\.csv$/i.test(productFile.name) || !/\.csv$/i.test(searchFile.name)) {
      setStatus('nicheStatus', '目前只支持后台下载的 CSV 文件。', 'error');
      return;
    }

    const buttonElement = $('saveNiche');
    buttonElement.disabled = true;
    buttonElement.textContent = '正在读取并计算…';
    setStatus('nicheStatus', '正在读取两份 CSV、识别表头并计算数据…');

    try {
      const files = await Promise.all([productFile.text(), searchFile.text()]);
      const requestedName = String($('nicheName').value || '').trim();
      const calculated = NicheEngine.processFiles(files[0], files[1], requestedName);
      const normalizedName = calculated.name.trim().toLocaleLowerCase();
      const existing = state.niches.find(function (niche) {
        return niche.productId === product.id &&
          String(niche.name || '').trim().toLocaleLowerCase() === normalizedName;
      });

      if (existing) {
        const confirmed = window.confirm(
          '产品「' + product.name + '」中已经存在 Niche「' + existing.name +
          '」。确定覆盖这个 Niche 的原始数据并重新计算吗？其他 Niche 不会受到影响。'
        );
        if (!confirmed) {
          setStatus('nicheStatus', '已取消覆盖，原有数据未改变。', 'warn');
          return;
        }
      }

      const now = new Date().toISOString();
      const record = Object.assign({}, calculated, {
        id: existing ? existing.id : uid(),
        productId: product.id,
        name: calculated.name,
        productFileName: productFile.name,
        searchTermFileName: searchFile.name,
        createdAt: existing ? existing.createdAt : now,
        updatedAt: now
      });

      await saveRecord('niches', record);
      state.selectedNicheId = record.id;
      $('productCsv').value = '';
      $('searchTermCsv').value = '';
      $('nicheName').value = '';
      await refreshData();

      setStatus(
        'nicheStatus',
        (existing ? '已覆盖更新' : '已新增') + ' Niche「' + record.name + '」：' +
        formatNumber(record.productCount) + ' 个商品、' +
        formatNumber(record.searchTermCount) + ' 个搜索词。其他 Niche 数据保持不变。'
      );
    } catch (error) {
      setStatus('nicheStatus', error.message || '处理 CSV 时发生错误。', 'error');
    } finally {
      buttonElement.disabled = false;
      buttonElement.textContent = '计算并保存 Niche';
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 15000);
  }

  function downloadWorkbook() {
    const product = activeProduct();
    const niches = productNiches();
    if (!product || !niches.length) {
      setStatus('nicheStatus', '当前产品没有可导出的 Niche 数据。', 'warn');
      return;
    }

    const legacyNiches = niches.filter(function (niche) {
      return !Array.isArray(niche.searchTermHeaders) || !niche.searchTermHeaders.length;
    });
    if (legacyNiches.length) {
      const names = legacyNiches.map(function (niche) { return niche.name; }).join('、');
      const confirmed = window.confirm(
        '以下 Niche 是旧版保存的数据，尚未保存原始 ST 表的其他字段：' + names +
        '。如果继续导出，这些 Sheet 只会包含 6 个核心字段。建议先重新上传这些 Niche 的 Product CSV 和 Search Term CSV。仍然继续导出吗？'
      );
      if (!confirmed) {
        setStatus('nicheStatus', '已取消导出。重新上传旧版 Niche 的两份 CSV 后，即可补齐原始 ST 字段。', 'warn');
        return;
      }
    }

    try {
      const workbook = NicheEngine.buildWorkbook(niches, window.XLSX);
      const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([bytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      const safeName = product.name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Product';
      const date = new Date().toISOString().slice(0, 10);
      const filename = 'Niche_Data_' + safeName + '_' + date + '.xlsx';
      downloadBlob(blob, filename);
      setStatus('nicheStatus', '已生成「' + filename + '」，包含当前产品的全部 ' + niches.length + ' 个 Niche Sheet。');
    } catch (error) {
      setStatus('nicheStatus', error.message || '导出 Excel 失败。', 'error');
    }
  }

  function bindEvents() {
    $('addProduct').addEventListener('click', addProduct);
    $('newProductName').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') addProduct();
    });
    $('productSelect').addEventListener('change', function () {
      state.activeProductId = $('productSelect').value;
      state.selectedNicheId = '';
      renderAll();
    });
    $('productCsv').addEventListener('change', function () {
      autoFillNicheName($('productCsv').files[0]);
    });
    $('searchTermCsv').addEventListener('change', function () {
      autoFillNicheName($('searchTermCsv').files[0]);
    });
    $('saveNiche').addEventListener('click', saveNiche);
    $('downloadWorkbook').addEventListener('click', downloadWorkbook);
  }

  async function init() {
    bindEvents();
    try {
      state.db = await openDatabase();
      await refreshData();
      setStatus('productStatus', state.products.length
        ? '已读取本浏览器保存的产品和 Niche 数据。'
        : '请先添加产品。产品与 Niche 数据会保存在当前浏览器中。');
    } catch (error) {
      setStatus('productStatus', error.message, 'error');
      $('addProduct').disabled = true;
      $('saveNiche').disabled = true;
      $('downloadWorkbook').disabled = true;
    }
  }

  init();
}());
