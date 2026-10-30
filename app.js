/* ═══════════════════════════════════════════════
   Mis Lugares de Comida — app.js
   Stack: MapLibre GL JS + CARTO vector + IndexedDB
═══════════════════════════════════════════════ */

'use strict';

// ── IndexedDB setup ──────────────────────────────
const DB_NAME    = 'misLugares';
const DB_VERSION = 1;
const STORE_NAME = 'places';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbPut(place) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(place);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

// ── State ────────────────────────────────────────
let places      = [];
let mlMarkers   = {};       // id → { marker, popup }
let editingId   = null;
let pendingLatLng = null;
let ghostMarker = null;     // F4: confirmation pin
let sortOrder   = 'newest'; // F2: sort state
let currentTheme = localStorage.getItem('mapTheme') || 'positron'; // T3

// ── CARTO API key & vector style URLs ────────────
const CARTO_API_KEY = 'cb1_4y3u_1_d71a9bb496fb8ebdf33eefec';

const CARTO_THEMES = {
  'positron':    `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json?key=${CARTO_API_KEY}`,
  'voyager':     `https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json?key=${CARTO_API_KEY}`,
  'dark-matter': `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=${CARTO_API_KEY}`,
};

function buildStyle(themeKey) {
  return CARTO_THEMES[themeKey];
}

// ── Map setup ────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: buildStyle(currentTheme),
  center: [-99.1332, 19.4326],
  zoom: 13,
  pitch: 45,
  bearing: -10,
  antialias: true,
});

map.addControl(
  new maplibregl.NavigationControl({ visualizePitch: true }),
  'bottom-left'
);

// ── T3: Restore active theme button ─────────────
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.classList.toggle('active', btn.dataset.theme === currentTheme);
});

// ── Theme switcher ────────────────────────────────
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const theme = btn.dataset.theme;
    if (theme === currentTheme) return;
    currentTheme = theme;
    localStorage.setItem('mapTheme', theme); // T3

    // E6: sync body class for dark UI
    document.body.classList.toggle('dark-ui', theme === 'dark-matter');

    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const center  = map.getCenter();
    const zoom    = map.getZoom();
    const pitch   = map.getPitch();
    const bearing = map.getBearing();

    map.setStyle(buildStyle(theme));
    map.once('style.load', () => {
      map.jumpTo({ center, zoom, pitch, bearing });
      mlMarkers = {};
      renderAllMarkers();
    });
  });
});

// Apply dark UI on load if saved theme is dark-matter
if (currentTheme === 'dark-matter') {
  document.body.classList.add('dark-ui');
}

// ── Type → color + emoji ─────────────────────────
// E2: each type gets its own pin color
const TYPE_CONFIG = {
  tacos:       { emoji: '🌮', color: '#e85d04' },
  desayunos:   { emoji: '🍳', color: '#f4a261' },
  hamburguesa: { emoji: '🍔', color: '#e63946' },
  tortas:      { emoji: '🥪', color: '#a8dadc' },
  mariscos:    { emoji: '🦐', color: '#1d7EB4' },
  postres:     { emoji: '🍰', color: '#c77dff' },
  bebidas:     { emoji: '🧃', color: '#2dc653' },
  otro:        { emoji: '📍', color: '#0B3C43' },
};

function configFor(type) {
  return TYPE_CONFIG[type] || TYPE_CONFIG['otro'];
}
function emojiFor(type)  { return configFor(type).emoji; }
function colorFor(type)  { return configFor(type).color; }

// ── Build marker DOM element ──────────────────────
function buildMarkerEl(type) {
  const { emoji, color } = configFor(type);
  const el = document.createElement('div');
  el.className = 'map-marker';
  el.innerHTML = `
    <div class="map-marker-pin" style="background:${color}">
      <span class="map-marker-emoji">${emoji}</span>
    </div>
    <div class="map-marker-shadow"></div>`;
  return el;
}

// ── F5: compress image before storing ────────────
function compressImage(dataURL, maxW = 800, quality = 0.72) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale  = Math.min(1, maxW / img.width);
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(img.width  * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataURL;
  });
}

// ── E8: Lightbox ─────────────────────────────────
function openLightbox(src) {
  const lb = document.getElementById('lightbox');
  document.getElementById('lightbox-img').src = src;
  lb.classList.remove('hidden');
}

document.getElementById('lightbox').addEventListener('click', () => {
  document.getElementById('lightbox').classList.add('hidden');
});

// ── Popup HTML builder ───────────────────────────
function buildPopupHTML(p) {
  const stars = '★'.repeat(p.rating || 0) + '☆'.repeat(5 - (p.rating || 0));
  const imgTag = p.photo
    ? `<img class="popup-img" src="${p.photo}" alt="foto" onclick="openLightbox('${p.photo}')" style="cursor:zoom-in" />`
    : '';
  const notes = p.notes
    ? `<div class="popup-notes">${escHtml(p.notes)}</div>` : '';
  const meta = [p.schedule, p.price].filter(Boolean).map(escHtml).join(' · ');
  const urlTag = p.url
    ? `<a class="popup-url" href="${escHtml(p.url)}" target="_blank" rel="noopener">🔗 Ver en Maps</a>` : '';
  const tags = (p.tags || []).length
    ? `<div class="popup-tags">${p.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}</div>` : '';
  return `
    <div class="popup-card">
      ${imgTag}
      <div class="popup-body">
        <div class="popup-name">${escHtml(p.name)}</div>
        <div class="popup-type">${emojiFor(p.type)} ${escHtml(p.type)}</div>
        ${p.rating ? `<div class="popup-stars">${stars}</div>` : ''}
        ${tags}
        ${notes}
        ${meta ? `<div class="popup-price-schedule">${meta}</div>` : ''}
        ${urlTag}
        <button class="popup-edit-btn" onclick="openEditModal('${p.id}')">✏️ Editar</button>
      </div>
    </div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Add / refresh a marker on the map ───────────
function renderMarker(p) {
  if (mlMarkers[p.id]) mlMarkers[p.id].marker.remove();

  const popup = new maplibregl.Popup({ offset: 30, maxWidth: '270px', closeButton: true })
    .setHTML(buildPopupHTML(p));

  const el     = buildMarkerEl(p.type);
  const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([p.lng, p.lat])
    .setPopup(popup)
    .addTo(map);

  mlMarkers[p.id] = { marker, popup };
}

function removeMarker(id) {
  if (mlMarkers[id]) { mlMarkers[id].marker.remove(); delete mlMarkers[id]; }
}

// ── Render all markers (respecting active filters) ─
function renderAllMarkers() {
  const query      = document.getElementById('search-input').value.trim().toLowerCase();
  const typeFilter = document.getElementById('filter-type').value;

  places.forEach(p => {
    const matchType  = !typeFilter || p.type === typeFilter;
    const matchQuery = !query
      || p.name.toLowerCase().includes(query)
      || (p.notes || '').toLowerCase().includes(query)
      || p.type.toLowerCase().includes(query)
      || (p.tags || []).some(t => t.toLowerCase().includes(query));

    if (matchType && matchQuery) {
      if (!mlMarkers[p.id]) renderMarker(p);
    } else {
      removeMarker(p.id);
    }
  });
}

// ── F2: Sort helpers ──────────────────────────────
function sortedPlaces(list) {
  const q  = document.getElementById('search-input').value.trim().toLowerCase();
  const tf = document.getElementById('filter-type').value;
  const filtered = list.filter(p => {
    const mt = !tf || p.type === tf;
    const mq = !q
      || p.name.toLowerCase().includes(q)
      || (p.notes || '').toLowerCase().includes(q)
      || p.type.toLowerCase().includes(q)
      || (p.tags || []).some(t => t.toLowerCase().includes(q));
    return mt && mq;
  });

  return filtered.sort((a, b) => {
    if (sortOrder === 'rating')  return (b.rating || 0) - (a.rating || 0);
    if (sortOrder === 'name')    return a.name.localeCompare(b.name, 'es');
    return (b.createdAt || 0) - (a.createdAt || 0); // newest
  });
}

document.getElementById('sort-select').addEventListener('change', e => {
  sortOrder = e.target.value;
  renderSidebar();
});

// ── Sidebar list ─────────────────────────────────
function renderSidebar() {
  const filtered = sortedPlaces(places);
  document.getElementById('count').textContent = filtered.length;
  const ul = document.getElementById('places-list');

  // E4: skeleton while painting
  ul.innerHTML = filtered.length === 0
    ? '<li style="padding:20px;color:#57606a;text-align:center">Sin resultados</li>'
    : filtered.map(p => {
        const stars    = '★'.repeat(p.rating || 0) + '☆'.repeat(5 - (p.rating || 0));
        const thumbHTML = p.photo
          ? `<img class="place-thumb" src="${p.photo}" alt="" />`
          : `<div class="place-thumb-icon" style="background:${colorFor(p.type)}">${emojiFor(p.type)}</div>`;
        const tagsHTML = (p.tags || []).length
          ? `<div class="place-tags-row">${p.tags.map(t => `<span class="tag tag-sm">${escHtml(t)}</span>`).join('')}</div>` : '';
        return `<li class="place-item" data-id="${p.id}">
          ${thumbHTML}
          <div class="place-info">
            <div class="place-name">${escHtml(p.name)}</div>
            <div class="place-meta">${emojiFor(p.type)} ${escHtml(p.type)}${p.price ? ' · ' + escHtml(p.price) : ''}</div>
            <div class="place-stars">${stars}</div>
            ${tagsHTML}
          </div>
        </li>`;
      }).join('');

  // Attach click listeners after render
  ul.querySelectorAll('.place-item').forEach(li => {
    li.addEventListener('click', () => {
      const p     = places.find(x => x.id === li.dataset.id);
      const entry = p && mlMarkers[p.id];
      if (entry) {
        map.flyTo({ center: [p.lng, p.lat], zoom: 17, pitch: 45, bearing: -10, duration: 800 });
        setTimeout(() => entry.marker.togglePopup(), 850);
      }
      closeSidebar();
    });
  });
}

// ── Modal helpers ─────────────────────────────────
const overlay = document.getElementById('modal-overlay');
const form    = document.getElementById('place-form');

function openAddModal(latlng) {
  editingId = null;
  pendingLatLng = latlng;
  resetForm();
  document.getElementById('modal-title').textContent = 'Nuevo lugar';
  document.getElementById('btn-delete').classList.add('hidden');
  overlay.classList.remove('hidden');
  // E1: trigger slide-up animation
  requestAnimationFrame(() => overlay.querySelector('.modal').classList.add('modal-visible'));
}

window.openEditModal = function(id) {
  const p = places.find(x => x.id === id);
  if (!p) return;
  editingId = id;
  pendingLatLng = null;

  document.getElementById('modal-title').textContent = 'Editar lugar';
  document.getElementById('f-id').value       = p.id;
  document.getElementById('f-lat').value      = p.lat;
  document.getElementById('f-lng').value      = p.lng;
  document.getElementById('f-name').value     = p.name;
  document.getElementById('f-type').value     = p.type;
  document.getElementById('f-notes').value    = p.notes || '';
  document.getElementById('f-rating').value   = p.rating || 0;
  document.getElementById('f-schedule').value = p.schedule || '';
  document.getElementById('f-price').value    = p.price || '';
  document.getElementById('f-url').value      = p.url || '';
  document.getElementById('f-tags').value     = (p.tags || []).join(', ');
  updateStarUI(p.rating || 0);

  const preview = document.getElementById('f-photo-preview');
  if (p.photo) { preview.src = p.photo; preview.classList.remove('hidden'); }
  else          { preview.classList.add('hidden'); }

  document.getElementById('btn-delete').classList.remove('hidden');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => overlay.querySelector('.modal').classList.add('modal-visible'));
};

function closeModal() {
  const modal = overlay.querySelector('.modal');
  modal.classList.remove('modal-visible');
  setTimeout(() => {
    overlay.classList.add('hidden');
    editingId = null;
    pendingLatLng = null;
  }, 240);
}

function resetForm() {
  form.reset();
  ['f-id','f-lat','f-lng','f-url','f-tags'].forEach(id =>
    document.getElementById(id).value = ''
  );
  document.getElementById('f-rating').value = '0';
  updateStarUI(0);
  const preview = document.getElementById('f-photo-preview');
  preview.src = '';
  preview.classList.add('hidden');
}

// ── Star rating UI ────────────────────────────────
function updateStarUI(value) {
  document.querySelectorAll('#stars-row .star').forEach(s => {
    s.classList.toggle('active', parseInt(s.dataset.v, 10) <= value);
  });
}

document.querySelectorAll('#stars-row .star').forEach(star => {
  star.addEventListener('click', () => {
    const v = parseInt(star.dataset.v, 10);
    document.getElementById('f-rating').value = v;
    updateStarUI(v);
  });
  star.addEventListener('mouseenter', () => {
    const v = parseInt(star.dataset.v, 10);
    document.querySelectorAll('#stars-row .star').forEach(s =>
      s.classList.toggle('hover', parseInt(s.dataset.v, 10) <= v)
    );
  });
  star.addEventListener('mouseleave', () =>
    document.querySelectorAll('#stars-row .star').forEach(s => s.classList.remove('hover'))
  );
});

// ── Photo file input ──────────────────────────────
document.getElementById('f-photo').addEventListener('change', function() {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const preview = document.getElementById('f-photo-preview');
    preview.src = e.target.result;
    preview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
});

// ── Form submit ───────────────────────────────────
form.addEventListener('submit', async e => {
  e.preventDefault();

  const lat = editingId
    ? parseFloat(document.getElementById('f-lat').value)
    : pendingLatLng.lat;
  const lng = editingId
    ? parseFloat(document.getElementById('f-lng').value)
    : pendingLatLng.lng;

  const rawTags = document.getElementById('f-tags').value
    .split(',').map(t => t.trim()).filter(Boolean);

  const photoInput = document.getElementById('f-photo');
  const previewSrc = document.getElementById('f-photo-preview').src;

  // Resolve photo source
  let rawPhoto = '';
  if (photoInput.files[0]) {
    rawPhoto = await new Promise(resolve => {
      const r = new FileReader();
      r.onload = ev => resolve(ev.target.result);
      r.readAsDataURL(photoInput.files[0]);
    });
  } else if (previewSrc && previewSrc.startsWith('data:')) {
    rawPhoto = previewSrc;
  }

  // F5: compress if there's a photo
  const photoData = rawPhoto ? await compressImage(rawPhoto) : '';

  const place = {
    id:        editingId || genId(),
    lat, lng,
    name:      document.getElementById('f-name').value.trim(),
    type:      document.getElementById('f-type').value,
    notes:     document.getElementById('f-notes').value.trim(),
    rating:    parseInt(document.getElementById('f-rating').value, 10) || 0,
    schedule:  document.getElementById('f-schedule').value.trim(),
    price:     document.getElementById('f-price').value.trim(),
    url:       document.getElementById('f-url').value.trim(),   // F6
    tags:      rawTags,                                          // F8
    photo:     photoData,
    createdAt: editingId
      ? (places.find(x => x.id === editingId) || {}).createdAt || Date.now()
      : Date.now(),
  };

  await dbPut(place);

  if (editingId) {
    const idx = places.findIndex(x => x.id === editingId);
    if (idx !== -1) places[idx] = place; else places.push(place);
  } else {
    places.push(place);
  }

  removeMarker(place.id);
  renderMarker(place);
  renderAllMarkers();
  renderSidebar();
  closeModal();
  clearGhostPin(); // F4

  setTimeout(() => {
    if (mlMarkers[place.id]) mlMarkers[place.id].marker.togglePopup();
  }, 300);
});

// ── Delete ────────────────────────────────────────
document.getElementById('btn-delete').addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('¿Eliminar este lugar?')) return;
  await dbDelete(editingId);
  places = places.filter(x => x.id !== editingId);
  removeMarker(editingId);
  renderSidebar();
  closeModal();
});

// ── Cancel ────────────────────────────────────────
document.getElementById('btn-cancel').addEventListener('click', () => {
  closeModal();
  clearGhostPin(); // F4
});
overlay.addEventListener('click', e => {
  if (e.target === overlay) { closeModal(); clearGhostPin(); }
});

// ── Sidebar toggle ────────────────────────────────
function openSidebar() { renderSidebar(); document.getElementById('sidebar').classList.remove('hidden'); }
function closeSidebar() { document.getElementById('sidebar').classList.add('hidden'); }

document.getElementById('btn-list').addEventListener('click', () => {
  const sb = document.getElementById('sidebar');
  if (sb.classList.contains('hidden')) openSidebar(); else closeSidebar();
});
document.getElementById('btn-close-sidebar').addEventListener('click', closeSidebar);

// ── F4: Ghost pin (confirm location before modal) ─
function showGhostPin(lngLat) {
  clearGhostPin();
  const el = document.createElement('div');
  el.className = 'ghost-pin';
  el.innerHTML = `
    <div class="ghost-pin-inner">📍</div>
    <div class="ghost-pin-actions">
      <button id="ghost-confirm">✓ Aquí</button>
      <button id="ghost-cancel">✕</button>
    </div>`;

  ghostMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat(lngLat)
    .addTo(map);

  el.querySelector('#ghost-confirm').addEventListener('click', e => {
    e.stopPropagation();
    const ll = ghostMarker.getLngLat();
    clearGhostPin();
    openAddModal({ lat: ll.lat, lng: ll.lng });
  });
  el.querySelector('#ghost-cancel').addEventListener('click', e => {
    e.stopPropagation();
    clearGhostPin();
  });
}

function clearGhostPin() {
  if (ghostMarker) { ghostMarker.remove(); ghostMarker = null; }
}

// ── Map click → show ghost pin ────────────────────
map.on('click', e => {
  if (e.originalEvent.target.closest('.map-marker,.ghost-pin,.maplibregl-popup')) return;
  showGhostPin(e.lngLat);
});

// ── Geolocation button ────────────────────────────
document.getElementById('btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) { alert('Tu navegador no soporta geolocalización'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      map.flyTo({ center: [latlng.lng, latlng.lat], zoom: 17, pitch: 45, duration: 800 });
      setTimeout(() => showGhostPin({ lng: latlng.lng, lat: latlng.lat }), 900);
    },
    () => alert('No se pudo obtener tu ubicación. Asegúrate de dar permiso.'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// ── T2: Debounced search/filter ───────────────────
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

const onFilterChange = debounce(() => {
  renderAllMarkers();
  if (!document.getElementById('sidebar').classList.contains('hidden')) renderSidebar();
}, 200);

document.getElementById('search-input').addEventListener('input', onFilterChange);
document.getElementById('filter-type').addEventListener('change', onFilterChange);

// ── F1: Export to JSON ────────────────────────────
document.getElementById('btn-export').addEventListener('click', () => {
  const exportData = places.map(p => {
    // Exclude large photo data from export by default to keep file small;
    // include it so data is complete
    return p;
  });
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `mis-lugares-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── F1: Import from JSON ──────────────────────────
document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('import-file').click();
});

document.getElementById('import-file').addEventListener('change', async function() {
  const file = this.files[0];
  if (!file) return;
  try {
    const text   = await file.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Formato inválido');

    const confirmed = confirm(
      `Se importarán ${parsed.length} lugares.\n¿Reemplazar todos los datos actuales o agregar a los existentes?\n\nAceptar = Reemplazar todo\nCancelar = Agregar`
    );

    if (confirmed) {
      await dbClear();
      places = [];
      Object.keys(mlMarkers).forEach(id => removeMarker(id));
      mlMarkers = {};
    }

    for (const p of parsed) {
      if (!p.id || !p.lat || !p.lng || !p.name) continue;
      await dbPut(p);
      const idx = places.findIndex(x => x.id === p.id);
      if (idx !== -1) places[idx] = p; else places.push(p);
    }

    renderAllMarkers();
    renderSidebar();
    alert(`✅ ${parsed.length} lugares importados correctamente.`);
  } catch (err) {
    alert('Error al importar: ' + err.message);
  }
  this.value = '';
});

// ── F7: Shareable link (encode single place in hash) ─
window.sharePlace = function(id) {
  const p = places.find(x => x.id === id);
  if (!p) return;
  const payload = btoa(encodeURIComponent(JSON.stringify({
    id: p.id, lat: p.lat, lng: p.lng, name: p.name,
    type: p.type, rating: p.rating, notes: p.notes,
  })));
  const url = `${location.origin}${location.pathname}#place=${payload}`;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => alert('🔗 Link copiado al portapapeles'));
  } else {
    prompt('Copia este link:', url);
  }
};

// Handle incoming shared place hash on load
function handleSharedHash() {
  const hash = location.hash;
  if (!hash.startsWith('#place=')) return;
  try {
    const payload = JSON.parse(decodeURIComponent(atob(hash.slice(7))));
    map.flyTo({ center: [payload.lng, payload.lat], zoom: 17, pitch: 45, duration: 1200 });
    setTimeout(() => {
      const entry = mlMarkers[payload.id];
      if (entry) entry.marker.togglePopup();
    }, 1400);
  } catch {}
}

// ── Helpers ───────────────────────────────────────
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── Service worker ────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ── Boot: load from IndexedDB, then render ────────
map.on('load', async () => {
  places = await dbGetAll();
  renderAllMarkers();
  handleSharedHash();

  if (places.length === 0 && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => map.flyTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 15 }),
      () => {}
    );
  }
});

// E8: expose lightbox to popup onclick
window.openLightbox = openLightbox;
