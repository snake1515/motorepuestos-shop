// JK2M Repuestos — lógica de la tienda contra Supabase (DB + Auth + Storage).
// El carrito y "Mis pedidos" viven en localStorage (son de este dispositivo);
// catálogo, cuentas, pedidos y configuración viven en Supabase.

const sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

const CART_KEY = 'eshop_cart';
const MY_ORDERS_KEY = 'jk2m_mis_pedidos';
const PAGE_SIZE = 24;
function lsGet(k, d){ try{ const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; }catch(e){ return d; } }
function lsSet(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){} }
// Cada línea del carrito guarda una copia del producto (nombre, código, precio, foto)
// para poder mostrarlo sin tener todo el catálogo cargado.
function loadCart(){ const c = lsGet(CART_KEY, []); return Array.isArray(c) ? c.filter(x => x && x.id && x.qty > 0) : []; }
function saveCart(c){ lsSet(CART_KEY, c); }

const DEFAULT_SETTINGS = {
  store_name: 'JK2M Repuestos', whatsapp: '', mensaje: '', tienda_abierta: true,
  mensaje_cerrada: 'La tienda en línea está cerrada en este momento. Escríbenos por WhatsApp.',
  mostrar_agotados: true, reserva_horas: 48, domicilio: true, envio_nacional: true, medios_pago: [],
};

let state = {
  settings: { ...DEFAULT_SETTINGS },
  categories: [],      // tabla categories (panel)
  chipCats: [],        // categorías con productos (fichas de la tienda)
  profile: null,       // perfil del usuario logueado (tipo, pct, is_admin)
  curCat: 'Todos',
  search: '',
  sort: 'default',
  items: [], total: 0, page: 1, loading: false, loadError: null,
  cache: new Map(),    // id → producto visto (catálogo, ficha, carrito)
  view: 'shop',
  adminTab: 'prod',
  adminProducts: [], adminLoaded: false, adminSearch: '', adminFilter: 'todos',
  orders: [], ordersFilter: 'pendiente', ordersCounts: {}, ordersMore: false,
  editId: null, imgFile: null,
  qtyId: null, qty: 1,
};

function fmt(n){ return '$' + Math.round(Number(n) || 0).toLocaleString('es-CO'); }
// Escapa texto que viene de la base de datos antes de meterlo en innerHTML (evita XSS)
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function norm(s){ return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function toTitle(s){
  const small=['de','del','la','las','el','los','y','en','a','con'];
  return (s||'').toString().trim().split(/\s+/).map((w,i)=>{
    const lw=w.toLowerCase();
    return (i>0 && small.includes(lw)) ? lw : (lw.charAt(0).toUpperCase()+lw.slice(1));
  }).join(' ');
}
function priceFor(base){
  if(!state.profile) return Number(base) || 0;
  return Math.round((Number(base) || 0) * (1 - (state.profile.pct||0)/100));
}
function isAdmin(){ return !!(state.profile && state.profile.is_admin); }
function storeName(){ return state.settings.store_name || 'JK2M Repuestos'; }
function storeOpen(){ return state.settings.tienda_abierta !== false; }
function remember(p){ if(p && p.id) state.cache.set(p.id, p); return p; }
function siteUrl(){ return location.origin + location.pathname; }
// Número del negocio en formato internacional (57 + celular)
function waNumber(n){
  const d = String(n || '').replace(/\D/g, '');
  if(!d) return '';
  return d.length === 10 ? '57' + d : d;
}
function waLink(num, text){ const n = waNumber(num); return n ? 'https://wa.me/' + n + '?text=' + encodeURIComponent(text) : ''; }
const ENTREGAS = { recoger: 'Recojo en el local', domicilio: 'Domicilio', envio: 'Envío nacional' };
function entregaTexto(o){
  const base = ENTREGAS[o.entrega] || 'Recojo en el local';
  return o.entrega && o.entrega !== 'recoger' ? base + ' — ' + [o.direccion, o.ciudad].filter(Boolean).join(', ') : base;
}
function mediosPago(){ return Array.isArray(state.settings.medios_pago) ? state.settings.medios_pago.filter(m => m && m.nombre) : []; }
function payBoxHtml(){
  const ms = mediosPago();
  if(!ms.length) return '';
  return `<div class="paybox"><b>Medios de pago</b>${ms.map(m => `<div><span>${esc(m.nombre)}</span>${m.detalle ? `<span class="pd">${esc(m.detalle)}</span>` : ''}</div>`).join('')}<small>Paga cuando te confirmemos la disponibilidad por WhatsApp.</small></div>`;
}

function closeModal(id){
  document.getElementById(id).classList.remove('show');
  if((id === 'qtyModal' && location.hash.startsWith('#p-')) || (id === 'orderModal' && location.hash.startsWith('#pedido-'))){
    history.replaceState(null, '', location.pathname + location.search);
  }
}
function openModal(id){ document.getElementById(id).classList.add('show'); }

// ───────────────────────────── Carga de datos ─────────────────────────
function friendlyError(err){
  const m = (err && (err.message || err.details || String(err))) || 'Error desconocido';
  if(/Could not find the function|PGRST202|schema cache/i.test(m)) return 'La tienda se está actualizando. Vuelve a intentarlo en unos minutos.';
  if(/Failed to fetch|NetworkError|fetch/i.test(m)) return 'No hay conexión con el servidor. Revisa tu internet y recarga la página.';
  return m;
}

async function loadSettings(){
  try{
    const { data, error } = await sb.from('settings').select('*').eq('id', 1).maybeSingle();
    if(!error && data) state.settings = { ...DEFAULT_SETTINGS, ...data };
  }catch(e){ /* sin configuración: valores por defecto */ }
}

async function loadCategories(){
  try{
    const [{ data: cats }, { data: chips }] = await Promise.all([
      sb.from('categories').select('name').order('name'),
      sb.rpc('category_list'),
    ]);
    state.categories = (cats || []).map(c => c.name);
    state.chipCats = Array.isArray(chips) ? chips : state.categories;
  }catch(e){ /* las fichas quedan vacías */ }
}

let catSeq = 0;
async function loadPage(append, fromSearch){
  const seq = ++catSeq;
  const page = append ? state.page + 1 : 1;
  state.loading = true; renderMore();
  let res;
  try{
    res = await sb.rpc('catalog_page', {
      p_q: state.search, p_cat: state.curCat === 'Todos' ? null : state.curCat,
      p_sort: state.sort === 'default' ? '' : state.sort, p_page: page, p_size: PAGE_SIZE,
    });
  }catch(err){ res = { data: null, error: err }; }
  if(seq !== catSeq) return;               // llegó una búsqueda más nueva
  state.loading = false;
  if(res.error || !res.data){
    state.loadError = friendlyError(res.error);
    if(!append){ state.items = []; state.total = 0; }
    renderGrid(); return;
  }
  state.loadError = null;
  const items = (res.data.items || []).map(remember);
  state.items = append ? state.items.concat(items) : items;
  state.total = res.data.total || 0;
  state.page = page;
  renderGrid();
  // Código exacto (ej. JKM210333): abre directo la ficha del producto
  const q = state.search.trim().toLowerCase();
  if(fromSearch && !append && q && items.length === 1 && items[0].code && items[0].code.toLowerCase() === q) openProduct(items[0].id);
}

async function fetchProducts(ids){
  ids = [...new Set(ids)].filter(Boolean);
  if(!ids.length) return [];
  const { data, error } = await sb.rpc('products_by_ids', { p_ids: ids });
  if(error) throw error;
  return (data || []).map(remember);
}

async function loadProfile(){
  const { data:{ session } } = await sb.auth.getSession();
  if(!session){ state.profile = null; return; }
  const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
  state.profile = error ? null : data;
}

// ───────────────────────────── Render ──────────────────────────────────
function renderCatSelect(){
  const cats = ['Todos', ...state.chipCats];
  document.getElementById('catChips').innerHTML = cats.map((c,i)=>
    `<button class="chip ${c===state.curCat?'active':''}" onclick="setCatIdx(${i})" aria-pressed="${c===state.curCat}">${esc(c)}</button>`).join('');
  const act = document.querySelector('#catChips .chip.active');
  if(act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest', inline: 'center' });
  document.getElementById('catTitle').textContent = state.search ? 'Resultados' : (state.curCat==='Todos' ? 'Catálogo' : state.curCat);
}
function setCat(c){ state.curCat = c; state.view = 'shop'; render(); loadPage(false); }
function setCatIdx(i){ setCat(['Todos', ...state.chipCats][i] || 'Todos'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
let searchTimer = null;
function onSearch(v){
  state.search = v.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(()=>{ render(); loadPage(false, true); }, 280);
}
function onSortChange(v){ state.sort = v; loadPage(false); }

const NO_IMG = '<span class="noimg"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13.5" r="3.5"/></svg>Sin foto</span>';

function cardHtml(p){
  const fp = priceFor(p.price);
  const showBase = state.profile && fp !== Number(p.price);
  const out = (p.disponible || 0) < 1;
  return `<article class="card">
    <button class="thumb" onclick="openProduct(${p.id})" aria-label="Ver ${esc(p.name)}">${p.featured ? '<span class="feat">Destacado</span>' : ''}${p.image_url ? `<img src="${esc(p.image_url)}" loading="lazy" alt="">` : NO_IMG}</button>
    <div class="card-body">
      ${p.code ? `<span class="code">${esc(p.code)}</span>` : ''}
      <h3 class="pname" onclick="openProduct(${p.id})">${esc(p.name)}</h3>
      <div class="cat-tag">${esc(p.category)}</div>
      <div class="price-row"><span class="price">${fmt(fp)}</span>${showBase ? `<span class="price-base">${fmt(p.price)}</span>` : ''}</div>
      <div class="stock ${out?'out':''}">${out ? 'Agotado' : p.disponible + (p.disponible===1 ? ' disponible' : ' disponibles')}</div>
      <button class="btn btn-sm" ${out || !storeOpen() ? 'disabled' : ''} onclick="openProduct(${p.id})">${out ? 'Agotado' : 'Agregar'}</button>
    </div></article>`;
}

function renderGrid(){
  const cnt = document.getElementById('resultCount');
  if(cnt) cnt.textContent = state.loadError ? '' : (state.total === 1 ? '1 producto' : state.total.toLocaleString('es-CO') + ' productos');
  const grid = document.getElementById('grid');
  if(state.loadError){
    grid.innerHTML = `<div class="empty">No se pudo cargar el catálogo.<br><small style="opacity:.75">${esc(state.loadError)}</small></div>`;
  } else if(!state.items.length){
    grid.innerHTML = state.loading ? '' : `<div class="empty">No encontramos productos${state.search ? ' para “' + esc(state.search) + '”' : ''}. Prueba con otra palabra o con el código.</div>`;
  } else {
    grid.innerHTML = state.items.map(cardHtml).join('');
  }
  renderMore();
}
function renderMore(){
  const el = document.getElementById('moreWrap');
  if(!el) return;
  const left = state.total - state.items.length;
  if(state.view === 'admin' && isAdmin()){ el.innerHTML = ''; return; }
  if(state.loading && !state.items.length){ el.innerHTML = '<div class="empty">Cargando productos…</div>'; return; }
  el.innerHTML = left > 0 && !state.loadError
    ? `<button class="btn-outline" onclick="loadPage(true)" ${state.loading ? 'disabled' : ''}>${state.loading ? 'Cargando…' : `Ver más productos (${left.toLocaleString('es-CO')} más)`}</button>`
    : '';
}

function renderAcct(){
  const btn = document.getElementById('acctBtn');
  btn.innerHTML = `<span class="acct-label">${state.profile ? esc(state.profile.email.split('@')[0]) + ' · salir' : 'Ingresar'}</span>`;
  document.getElementById('passBtn').style.display = state.profile ? '' : 'none';
}
async function onAcctClick(){
  if(state.profile){ await sb.auth.signOut(); state.profile=null; state.view='shop'; render(); loadPage(false); }
  else openModal('authModal');
}

function renderAdminBar(){
  const bar = document.getElementById('adminBar');
  if(!isAdmin()){ bar.innerHTML=''; return; }
  bar.innerHTML = `<div class="row" style="margin-bottom:16px"><span class="badge">Modo administrador</span>
    <button class="btn btn-sm" onclick="toggleAdmin()">${state.view==='admin'?'Volver a la tienda':'Abrir panel de administración'}</button></div>`;
}
function toggleAdmin(){
  state.view = state.view==='admin' ? 'shop' : 'admin';
  if(state.view === 'admin' && !state.adminLoaded) loadAdminProducts();
  if(state.view === 'shop') loadPage(false);
  render();
}

function renderClosed(){
  const el = document.getElementById('closedBanner');
  if(storeOpen() || (state.view === 'admin' && isAdmin())){ el.style.display = 'none'; return; }
  const wa = waLink(state.settings.whatsapp, 'Hola ' + storeName() + ', quiero hacer un pedido.');
  el.innerHTML = `<b>Tienda cerrada</b><span>${esc(state.settings.mensaje_cerrada)}</span>${wa ? `<a class="btn btn-sm btn-wa" href="${wa}" target="_blank" rel="noopener">Escribir por WhatsApp</a>` : ''}`;
  el.style.display = '';
}

function render(){
  const admin = state.view==='admin' && isAdmin();
  document.getElementById('grid').style.display = admin ? 'none' : '';
  document.getElementById('toolbar').style.display = admin ? 'none' : '';
  document.getElementById('catChips').style.display = admin ? 'none' : '';
  // La presentación solo se muestra al entrar (sin búsqueda ni categoría elegida)
  document.getElementById('intro').style.display = (admin || state.search || state.curCat!=='Todos') ? 'none' : '';
  if(state.settings.mensaje) document.getElementById('introMsg').textContent = state.settings.mensaje;
  document.getElementById('adminPanel').style.display = admin ? 'block' : 'none';
  document.getElementById('moreWrap').style.display = admin ? 'none' : '';
  renderCatSelect(); renderAcct(); renderAdminBar(); renderClosed();
  if(admin) renderAdminPanel(); else renderGrid();
  document.getElementById('cartCount').textContent = loadCart().reduce((s,it)=>s+it.qty,0);
}

// ───────────────────────────── Autenticación ───────────────────────────
function switchAuth(mode){
  document.getElementById('tabLogin').classList.toggle('active', mode==='login');
  document.getElementById('tabReg').classList.toggle('active', mode==='reg');
  document.getElementById('authSubmit').textContent = mode==='login' ? 'Ingresar' : 'Crear cuenta';
  document.getElementById('authSubmit').dataset.mode = mode;
  document.getElementById('authMsg').innerHTML = '';
}

async function submitAuth(){
  const email = document.getElementById('authEmail').value.trim().toLowerCase();
  const pass = document.getElementById('authPass').value;
  const mode = document.getElementById('authSubmit').dataset.mode || 'login';
  const msg = document.getElementById('authMsg');
  if(!email || !pass){ msg.innerHTML='<div class="msg err">Completa correo y contraseña.</div>'; return; }
  msg.innerHTML = '<div class="msg" style="background:var(--panel2);color:var(--muted)">Un momento...</div>';
  if(mode==='reg'){
    const { data, error } = await sb.auth.signUp({ email, password: pass });
    if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
    if(data.user && !data.session){
      msg.innerHTML = '<div class="msg ok">Cuenta creada. Revisa tu correo para confirmarla y luego ingresa.</div>';
      switchAuth('login');
      return;
    }
    // El perfil lo crea la base de datos (trigger de migracion_seguridad_perfiles.sql).
    msg.innerHTML = '<div class="msg ok">Cuenta creada. El precio que verás depende del tipo de cliente que te asigne la tienda.</div>';
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    if(error){ msg.innerHTML = `<div class="msg err">${esc(error.message)}</div>`; return; }
  }
  await loadProfile();
  setTimeout(()=>{ closeModal('authModal'); render(); loadPage(false); }, 500);
}

async function changePass(){
  const n = prompt('Nueva contraseña (mínimo 6 caracteres):');
  if(!n) return;
  const { error } = await sb.auth.updateUser({ password: n });
  alert(error ? 'No se pudo actualizar: '+error.message : 'Contraseña actualizada.');
}

// ───────────────────────────── Admin: panel ────────────────────────────
function adminProduct(id){ return state.adminProducts.find(p => p.id === id) || null; }

async function loadAdminProducts(){
  const all = [];
  for(let from = 0; ; from += 1000){
    const { data, error } = await sb.from('products').select('id,name,code,category,price,stock,featured,image_url')
      .order('name').order('id').range(from, from + 999);
    if(error){ state.adminError = friendlyError(error); break; }
    all.push(...data);
    if(data.length < 1000) break;
  }
  state.adminProducts = all; state.adminLoaded = true;
  if(state.view === 'admin') renderAdminPanel();
}
async function refreshAfterProductChange(){
  await Promise.all([loadAdminProducts(), loadCategories()]);
  render();
}

function renderAdminPanel(){
  const el = document.getElementById('adminPanel');
  const t = state.adminTab;
  const tabs = `<div class="tabs">
    <button class="${t==='prod'?'active':''}" onclick="setAdminTab('prod')">Productos (${state.adminProducts.length})</button>
    <button class="${t==='orders'?'active':''}" onclick="setAdminTab('orders')">Pedidos${state.ordersCounts.pendiente ? ` (${state.ordersCounts.pendiente} pendientes)` : ''}</button>
    <button class="${t==='cat'?'active':''}" onclick="setAdminTab('cat')">Categorías</button>
    <button class="${t==='config'?'active':''}" onclick="setAdminTab('config')">Configuración</button>
    <button onclick="openUsersAdmin()">Clientes</button></div>`;
  let body = '';
  if(t === 'prod') body = adminProductsHtml();
  else if(t === 'cat') body = adminCategoriesHtml();
  else if(t === 'orders') body = adminOrdersHtml();
  else body = adminConfigHtml();
  el.innerHTML = tabs + body;
}
function setAdminTab(t){
  state.adminTab = t;
  if(t === 'orders') loadOrders(false);
  renderAdminPanel();
}

function adminFiltered(){
  let ps = state.adminProducts;
  const f = state.adminFilter;
  if(f === 'sinfoto') ps = ps.filter(p => !p.image_url);
  else if(f === 'destacados') ps = ps.filter(p => p.featured);
  else if(f === 'agotados') ps = ps.filter(p => p.stock < 1);
  const words = norm(state.adminSearch).split(/\s+/).filter(Boolean);
  if(words.length) ps = ps.filter(p => { const h = norm(p.name + ' ' + (p.code||'') + ' ' + p.category); return words.every(w => h.includes(w)); });
  return ps;
}
function adminProductsHtml(){
  if(!state.adminLoaded) return `<div class="empty">${state.adminError ? esc(state.adminError) : 'Cargando productos…'}</div>`;
  const ps = adminFiltered();
  const enDb = state.adminProducts.filter(p => (p.image_url||'').startsWith('data:')).length;
  const opt = (v, l) => `<option value="${v}" ${state.adminFilter===v?'selected':''}>${l}</option>`;
  return `${enDb ? `<div class="notice"><div><b>${enDb} fotos</b> están guardadas dentro de la base de datos y hacen más lenta la tienda. Muévelas a Storage (se reducen solas, sin perder calidad visible).</div>
      <button class="btn btn-sm" id="migBtn" onclick="migratePhotos()">${state.migrating ? 'Moviendo…' : 'Mover fotos a Storage'}</button><div id="migMsg" class="img-info">${state.migMsg||''}</div></div>` : ''}
    <div class="row" style="margin-bottom:12px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="openProdModal(null)">+ Nuevo producto</button>
      <button class="btn-outline btn-sm" onclick="document.getElementById('xlsxImport').click()" title="Columnas: Producto, Código, Precio y (opcional) Existencias">Importar productos y precios (Excel)</button>
      <input type="file" id="xlsxImport" accept=".xlsx,.xls" style="display:none" onchange="importPriceList(this.files[0])">
      <select onchange="state.adminFilter=this.value;renderAdminPanel()" aria-label="Filtrar">${opt('todos','Todos')}${opt('sinfoto','Sin foto')}${opt('destacados','Destacados')}${opt('agotados','Agotados')}</select>
      <input id="adminSearchBox" placeholder="Buscar producto o código..." value="${esc(state.adminSearch)}" oninput="state.adminSearch=this.value;renderAdminTable()" style="flex:1;min-width:180px">
    </div>
    <div id="importMsg">${state.importMsg||''}</div>
    <div id="adminTable">${adminTableHtml(ps)}</div>`;
}
function adminTableHtml(ps){
  return `<div style="overflow-x:auto;max-height:65vh;overflow-y:auto"><table><tr><th></th><th>Producto</th><th>Código</th><th>Categoría</th><th>Precio base</th><th>Stock</th><th title="Destacado">★</th><th></th></tr>`
    + ps.slice(0,300).map(p=>`<tr><td style="width:52px"><div class="thumb" style="width:44px;height:44px">${p.image_url?`<img src="${esc(p.image_url)}" loading="lazy" alt="">`:''}</div></td><td>${esc(p.name)}</td><td style="color:var(--muted);font-size:12px">${esc(p.code||'')}</td><td>${esc(p.category)}</td><td>${fmt(p.price)}</td><td>${p.stock}</td>
      <td><button class="star ${p.featured?'on':''}" onclick="toggleFeatured(${p.id})" aria-label="Destacado" aria-pressed="${!!p.featured}">★</button></td>
      <td style="white-space:nowrap"><button class="btn btn-sm" onclick="openProdModal(${p.id})">Editar</button> <button class="btn-outline btn-sm" onclick="deleteProduct(${p.id})">Eliminar</button></td></tr>`).join('')
    + `</table></div>`
    + `<div style="color:var(--muted);font-size:13px;margin-top:8px">${ps.length > 300 ? `Mostrando 300 de ${ps.length}. Usa el buscador para acotar.` : `${ps.length} productos`}</div>`;
}
function renderAdminTable(){ const el = document.getElementById('adminTable'); if(el) el.innerHTML = adminTableHtml(adminFiltered()); }

async function toggleFeatured(id){
  const p = adminProduct(id); if(!p) return;
  const { error } = await sb.from('products').update({ featured: !p.featured }).eq('id', id);
  if(error){ alert('Error: ' + error.message); return; }
  p.featured = !p.featured; renderAdminTable();
}

function adminCategoriesHtml(){
  const ps = state.adminProducts;
  return `<div style="margin-bottom:12px"><button class="btn btn-sm" onclick="promptCategory()">+ Nueva categoría</button></div><div style="overflow-x:auto;max-height:65vh;overflow-y:auto"><table><tr><th>Categoría</th><th>Productos</th><th></th></tr>`
    + state.categories.map((c,i)=>`<tr><td>${esc(c)}</td><td>${ps.filter(p=>p.category===c).length}</td><td style="white-space:nowrap"><button class="btn btn-sm" onclick="renameCategory(${i})">Renombrar</button> <button class="btn-outline btn-sm" onclick="deleteCategory(${i})">Eliminar</button></td></tr>`).join('')
    + `</table></div>`;
}

// ───────────────────────────── Admin: configuración ────────────────────
function adminConfigHtml(){
  const s = state.settings;
  const chk = (id, v, l) => `<label class="check"><input type="checkbox" id="${id}" ${v ? 'checked' : ''}> ${l}</label>`;
  const medios = mediosPago().map(m => m.nombre + (m.detalle ? ': ' + m.detalle : '')).join('\n');
  return `<div class="cfg">
    <div class="field"><label for="cfName">Nombre de la tienda</label><input id="cfName" value="${esc(s.store_name)}"></div>
    <div class="field"><label for="cfWa">WhatsApp de la tienda (recibe los pedidos)</label><input id="cfWa" type="tel" value="${esc(s.whatsapp||'')}" placeholder="Ej: 3001234567"></div>
    <div class="field"><label for="cfMsg">Mensaje de bienvenida (opcional)</label><input id="cfMsg" value="${esc(s.mensaje||'')}" placeholder="Busca por nombre o por código, arma tu pedido…"></div>
    <div class="field"><label for="cfPay">Medios de pago (uno por línea, "Nombre: datos")</label><textarea id="cfPay" rows="4" placeholder="Nequi: 300 123 4567&#10;Bancolombia ahorros: 123-456789-00&#10;Efectivo en el local">${esc(medios)}</textarea></div>
    ${chk('cfDom', s.domicilio, 'Ofrecer domicilio')}
    ${chk('cfEnv', s.envio_nacional, 'Ofrecer envío nacional')}
    ${chk('cfAgo', s.mostrar_agotados, 'Mostrar productos agotados en la tienda')}
    <div class="field"><label for="cfRes">Horas que un pedido pendiente aparta las unidades</label><input id="cfRes" type="number" min="1" max="720" value="${s.reserva_horas}"></div>
    ${chk('cfOpen', s.tienda_abierta, 'Tienda abierta (recibe pedidos)')}
    <div class="field"><label for="cfClosed">Mensaje cuando la tienda está cerrada</label><input id="cfClosed" value="${esc(s.mensaje_cerrada||'')}"></div>
    <div id="cfMsgBox"></div>
    <button class="btn" onclick="saveSettings()" id="cfSave">Guardar configuración</button></div>`;
}
async function saveSettings(){
  const v = id => document.getElementById(id).value.trim();
  const c = id => document.getElementById(id).checked;
  const box = document.getElementById('cfMsgBox');
  const wa = v('cfWa').replace(/\D/g, '');
  if(wa && (wa.length < 10 || wa.length > 15)){ box.innerHTML = '<div class="msg err">El WhatsApp debe tener 10 dígitos (ej. 3001234567).</div>'; return; }
  const medios = v('cfPay').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 10).map(l => {
    const i = l.indexOf(':');
    return i > 0 ? { nombre: l.slice(0, i).trim(), detalle: l.slice(i + 1).trim() } : { nombre: l, detalle: '' };
  });
  const payload = {
    store_name: v('cfName') || 'JK2M Repuestos', whatsapp: wa || null, mensaje: v('cfMsg') || null,
    medios_pago: medios, domicilio: c('cfDom'), envio_nacional: c('cfEnv'), mostrar_agotados: c('cfAgo'),
    reserva_horas: Math.min(720, Math.max(1, parseInt(v('cfRes'), 10) || 48)),
    tienda_abierta: c('cfOpen'), mensaje_cerrada: v('cfClosed') || DEFAULT_SETTINGS.mensaje_cerrada,
    updated_at: new Date().toISOString(),
  };
  const btn = document.getElementById('cfSave'); btn.disabled = true;
  const { error } = await sb.from('settings').update(payload).eq('id', 1);
  btn.disabled = false;
  if(error){ box.innerHTML = `<div class="msg err">No se pudo guardar: ${esc(friendlyError(error))}</div>`; return; }
  await loadSettings();
  render();
  document.getElementById('cfMsgBox').innerHTML = '<div class="msg ok">Configuración guardada.</div>';
}

// ───────────────────────────── Admin: clientes ─────────────────────────
async function openUsersAdmin(){
  const { data: us, error } = await sb.from('profiles').select('*').order('email');
  if(error){ alert('No se pudo cargar la lista de clientes: '+error.message); return; }
  let html = `<h2>Clientes</h2>
  <p style="color:var(--muted);font-size:13px">Para crear una cuenta de cliente nueva, pídele que se registre desde "Crear cuenta" en la tienda; luego edítale aquí el tipo y el % de descuento.</p>
  <table><tr><th>Correo</th><th>Tipo</th><th>% Desc.</th><th></th></tr>`;
  us.filter(u=>!u.is_admin).forEach(u=>{
    html += `<tr><td>${esc(u.email)}</td>
      <td><input id="tipo_${u.id}" value="${esc(u.tipo)}" style="width:110px"></td>
      <td><input id="pct_${u.id}" type="number" value="${u.pct}" style="width:70px"></td>
      <td><button class="btn-sm btn" onclick="saveUser('${u.id}')">Guardar</button> <button class="btn-sm btn-outline" onclick="deleteUser('${u.id}')">Eliminar</button></td></tr>`;
  });
  html += '</table>';
  const wrap = document.createElement('div');
  wrap.className='modal-bg show'; wrap.id='usersModal';
  wrap.innerHTML = `<div class="modal wide"><button class="close-x" onclick="document.getElementById('usersModal').remove()">✕</button>${html}</div>`;
  document.body.appendChild(wrap);
}
async function saveUser(id){
  const tipo = document.getElementById('tipo_'+id).value;
  const pct = parseFloat(document.getElementById('pct_'+id).value) || 0;
  const { error } = await sb.from('profiles').update({ tipo, pct }).eq('id', id);
  if(error){ alert('Error: '+error.message); return; }
  document.getElementById('usersModal').remove();
  openUsersAdmin();
}
async function deleteUser(id){
  if(!confirm('Esto quita el perfil de precios del cliente (no borra su cuenta de acceso; para eso usa el panel de Supabase). ¿Continuar?')) return;
  const { error } = await sb.from('profiles').delete().eq('id', id);
  if(error){ alert('Error: '+error.message); return; }
  document.getElementById('usersModal').remove();
  openUsersAdmin();
}

// ───────────────────────────── Admin: pedidos ──────────────────────────
const ESTADOS = { pendiente: 'Pendiente', confirmado: 'Confirmado', entregado: 'Entregado', cancelado: 'Cancelado' };
async function loadOrdersCounts(){
  const res = await Promise.all(Object.keys(ESTADOS).map(s =>
    sb.from('orders').select('id', { count: 'exact', head: true }).eq('status', s)));
  const counts = {};
  Object.keys(ESTADOS).forEach((s, i) => { counts[s] = res[i].count || 0; });
  state.ordersCounts = counts;
}
async function loadOrders(append){
  const from = append ? state.orders.length : 0;
  let q = sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).range(from, from + 29);
  if(state.ordersFilter !== 'todos') q = q.eq('status', state.ordersFilter);
  const [{ data, error }] = await Promise.all([q, loadOrdersCounts()]);
  if(error){ state.ordersError = friendlyError(error); }
  else { state.ordersError = null; state.orders = append ? state.orders.concat(data) : data; state.ordersMore = data.length === 30; }
  state.ordersLoaded = true;
  if(state.view === 'admin' && state.adminTab === 'orders') renderAdminPanel();
}
function setOrdersFilter(f){ state.ordersFilter = f; state.ordersLoaded = false; renderAdminPanel(); loadOrders(false); }
function orderVencido(o){
  return o.status === 'pendiente' && (Date.now() - new Date(o.created_at).getTime()) > (state.settings.reserva_horas || 48) * 3600e3;
}
function adminOrdersHtml(){
  const c = state.ordersCounts;
  const chip = (f, l) => `<button class="chip ${state.ordersFilter===f?'active':''}" onclick="setOrdersFilter('${f}')">${l}${f!=='todos' && c[f] != null ? ' (' + c[f] + ')' : ''}</button>`;
  const head = `<div class="row" style="flex-wrap:wrap;margin-bottom:12px">${chip('pendiente','Pendientes')}${chip('confirmado','Confirmados')}${chip('entregado','Entregados')}${chip('cancelado','Cancelados')}${chip('todos','Todos')}
    <button class="btn-outline btn-sm" style="margin-left:auto" onclick="exportOrders()">Exportar a Excel</button></div>`;
  if(!state.ordersLoaded) return head + '<div class="empty">Cargando pedidos…</div>';
  if(state.ordersError) return head + `<div class="empty">${esc(state.ordersError)}</div>`;
  if(!state.orders.length) return head + '<div class="empty">No hay pedidos en esta lista.</div>';
  return head + state.orders.map(orderCardHtml).join('')
    + (state.ordersMore ? '<div class="more"><button class="btn-outline" onclick="loadOrders(true)">Ver más pedidos</button></div>' : '');
}
function orderCardHtml(o){
  const items = (o.order_items || []).slice().sort((a,b) => a.id - b.id);
  const waCli = waLink(o.whatsapp, `Hola ${o.customer_name || ''}, te escribimos de ${storeName()} por tu pedido #${o.id}.`);
  const btn = (s, l, cls) => `<button class="${cls||'btn-outline'} btn-sm" onclick="changeOrderStatus(${o.id},'${s}')">${l}</button>`;
  let acts = '';
  if(o.status === 'pendiente') acts = btn('confirmado', 'Confirmar (descuenta stock)', 'btn') + btn('entregado', 'Marcar entregado') + btn('cancelado', 'Cancelar');
  else if(o.status === 'confirmado') acts = btn('entregado', 'Marcar entregado', 'btn') + btn('cancelado', 'Cancelar (devuelve stock)');
  else if(o.status === 'entregado') acts = btn('cancelado', 'Anular (devuelve stock)');
  else acts = btn('pendiente', 'Reabrir');
  return `<div class="ocard st-${o.status}">
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:6px">
      <b>Pedido #${o.id} · ${esc(o.customer_name || 'Sin nombre')}</b>
      <span class="row" style="gap:6px"><span class="st st-${o.status}">${ESTADOS[o.status] || o.status}</span>${orderVencido(o) ? '<span class="st st-vencido">Reserva vencida</span>' : ''}</span>
    </div>
    <div class="ometa">${new Date(o.created_at).toLocaleString('es-CO')}${o.nit_cc ? ' · NIT/CC ' + esc(o.nit_cc) : ''}${o.whatsapp ? ' · WhatsApp ' + esc(o.whatsapp) : ''}${o.user_email ? ' · ' + esc(o.user_email) : ''}</div>
    <div class="ometa"><b>${esc(entregaTexto(o))}</b>${o.medio_pago ? ' · Pago: ' + esc(o.medio_pago) : ''}</div>
    ${o.nota ? `<div class="ometa">Nota: ${esc(o.nota)}</div>` : ''}
    <ul class="olines">${items.map(i => `<li><span>${i.qty} × ${esc(i.name)}${i.code ? ` <em>${esc(i.code)}</em>` : ''}</span><span>${fmt(i.qty * i.price)}</span></li>`).join('')}</ul>
    <div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px">
      <b class="ototal">Total ${fmt(o.total)}</b>
      <span class="row" style="flex-wrap:wrap;gap:6px">${acts}${waCli ? `<a class="btn-outline btn-sm" href="${waCli}" target="_blank" rel="noopener">WhatsApp al cliente</a>` : ''}</span>
    </div></div>`;
}
async function changeOrderStatus(id, status){
  const msgs = { cancelado: '¿Cancelar este pedido? Si ya había descontado stock, se devuelve.', pendiente: '¿Reabrir este pedido como pendiente?' };
  if(msgs[status] && !confirm(msgs[status])) return;
  const { error } = await sb.rpc('set_order_status', { p_id: id, p_status: status });
  if(error){ alert(friendlyError(error)); return; }
  showToast('Pedido #' + id + ': ' + ESTADOS[status]);
  await loadOrders(false);
  loadAdminProducts();
}
async function exportOrders(){
  const rows = [['Pedido', 'Fecha', 'Estado', 'Cliente', 'NIT/CC', 'WhatsApp', 'Correo', 'Entrega', 'Dirección', 'Ciudad', 'Pago', 'Nota', 'Código', 'Producto', 'Cantidad', 'Precio unitario', 'Subtotal']];
  for(let from = 0; from < 5000; from += 500){
    let q = sb.from('orders').select('*, order_items(*)').order('created_at', { ascending: false }).range(from, from + 499);
    if(state.ordersFilter !== 'todos') q = q.eq('status', state.ordersFilter);
    const { data, error } = await q;
    if(error){ alert(friendlyError(error)); return; }
    data.forEach(o => (o.order_items || []).sort((a,b) => a.id - b.id).forEach(i => rows.push([
      o.id, new Date(o.created_at).toLocaleString('es-CO'), ESTADOS[o.status] || o.status, o.customer_name || '', o.nit_cc || '',
      o.whatsapp || '', o.user_email || '', ENTREGAS[o.entrega] || '', o.direccion || '', o.ciudad || '', o.medio_pago || '', o.nota || '',
      i.code || '', i.name, i.qty, Number(i.price), i.qty * Number(i.price)])));
    if(data.length < 500) break;
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [6, 18, 11, 22, 14, 13, 22, 16, 24, 12, 12, 20, 12, 40, 9, 13, 12].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Pedidos');
  XLSX.writeFile(wb, `pedidos-${state.ordersFilter}-${new Date().toISOString().slice(0,10)}.xlsx`);
}

// ───────────────────────────── Admin: categorías ───────────────────────
async function promptCategory(){
  const c = (prompt('Nombre de la nueva categoría:')||'').trim();
  if(!c) return;
  const { error } = await sb.from('categories').insert({ name: toTitle(c) });
  if(error){ alert('Error: '+error.message); return; }
  await refreshAfterProductChange();
}
async function renameCategory(i){
  const old = state.categories[i];
  const n = (prompt('Nuevo nombre:', old)||'').trim();
  if(!n || n===old) return;
  await sb.from('categories').update({ name:n }).eq('name', old);
  await sb.from('products').update({ category:n }).eq('category', old);
  if(state.curCat===old) state.curCat=n;
  await refreshAfterProductChange();
}
async function deleteCategory(i){
  const c = state.categories[i];
  if(state.adminProducts.some(p=>p.category===c)){ alert('Esta categoría tiene productos. Muévelos o elimínalos primero.'); return; }
  if(!confirm('¿Eliminar la categoría '+c+'?')) return;
  await sb.from('categories').delete().eq('name', c);
  if(state.curCat===c) state.curCat='Todos';
  await refreshAfterProductChange();
}

// ───────────────────────────── Admin: productos ────────────────────────
document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('pImg').addEventListener('change', onImageChosen);
});
function openProdModal(id){
  state.editId = id; state.imgFile = null;
  document.getElementById('pCat').innerHTML = state.categories.map(c=>`<option>${esc(c)}</option>`).join('');
  const p = id ? adminProduct(id) : null;
  document.getElementById('pTitle').textContent = p ? 'Editar producto' : 'Nuevo producto';
  document.getElementById('pName').value = p ? p.name : '';
  document.getElementById('pCode').value = p ? (p.code||'') : '';
  document.getElementById('pPrice').value = p ? p.price : '';
  document.getElementById('pStock').value = p ? p.stock : 10;
  document.getElementById('pFeatured').checked = !!(p && p.featured);
  document.getElementById('pImg').value = '';
  document.getElementById('pMsg').innerHTML = '';
  resetImagePreview(p);
  if(p) document.getElementById('pCat').value = p.category;
  openModal('prodModal');
}
// ───────────────────────────── Optimización de imágenes ─────────────────
// Antes de subir una foto a Storage se reduce aquí, en el navegador:
//  1) se limita el lado mayor (la tarjeta del catálogo mide ~220 px; 1200 px cubre
//     pantallas retina y el modal de producto),
//  2) se reduce por pasos (mitades) para conservar la nitidez,
//  3) se busca la MAYOR calidad que quepa en el peso objetivo (WebP; JPEG si el
//     navegador no puede codificar WebP).
// Si la foto ya es liviana y pequeña, se sube tal cual (no se recomprime para nada).
const IMG_MAX_SIDE  = 1200;          // px del lado mayor
const IMG_MAX_BYTES = 300 * 1024;    // peso objetivo por foto
const IMG_Q_MAX = 0.95, IMG_Q_MIN = 0.55;   // 0.95 = casi sin pérdida visible; por encima el peso se dispara sin mejora notable

function fmtBytes(n){
  return n >= 1048576 ? (n/1048576).toFixed(1).replace('.', ',') + ' MB' : Math.max(1, Math.round(n/1024)) + ' KB';
}
function loadImage(file){
  // <img> aplica la orientación EXIF (fotos de celular), así no salen giradas
  return new Promise((resolve, reject)=>{
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = ()=>{ URL.revokeObjectURL(url); resolve(img); };
    img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}
function canvasToBlob(canvas, type, q){ return new Promise(res => canvas.toBlob(res, type, q)); }
function scaledCanvas(img, w, h, opaque){
  let src = img, cw = img.naturalWidth, ch = img.naturalHeight;
  while(cw / 2 >= w && ch / 2 >= h){            // reducción por pasos: más nítida que un solo salto
    const c = document.createElement('canvas');
    c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
    src = c; cw = c.width; ch = c.height;
  }
  const out = document.createElement('canvas'); out.width = w; out.height = h;
  const x = out.getContext('2d');
  if(opaque){ x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); }   // JPEG no tiene transparencia
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, h);
  return out;
}
async function optimizeImage(file){
  const img = await loadImage(file);
  const W0 = img.naturalWidth, H0 = img.naturalHeight;
  const webFormat = /^image\/(jpeg|png|webp)$/.test(file.type);
  if(webFormat && Math.max(W0, H0) <= IMG_MAX_SIDE && file.size <= IMG_MAX_BYTES){
    return { file, width: W0, height: H0, original: file.size, changed: false };
  }
  let scale = Math.min(1, IMG_MAX_SIDE / Math.max(W0, H0));
  let type = 'image/webp';
  let last = null;
  for(let attempt = 0; attempt < 6; attempt++){
    const w = Math.max(1, Math.round(W0 * scale)), h = Math.max(1, Math.round(H0 * scale));
    let canvas = scaledCanvas(img, w, h, type === 'image/jpeg');
    let blob = await canvasToBlob(canvas, type, IMG_Q_MAX);
    if(blob && blob.type !== type && type === 'image/webp'){   // este navegador no codifica WebP
      type = 'image/jpeg';
      canvas = scaledCanvas(img, w, h, true);
      blob = await canvasToBlob(canvas, type, IMG_Q_MAX);
    }
    if(!blob) throw new Error('No se pudo procesar la imagen');
    last = { blob, w, h };
    if(blob.size > IMG_MAX_BYTES){
      // búsqueda binaria: la mayor calidad que cabe en el peso objetivo
      let lo = IMG_Q_MIN, hi = IMG_Q_MAX, best = null;
      for(let i = 0; i < 6; i++){
        const q = (lo + hi) / 2;
        const b = await canvasToBlob(canvas, type, q);
        if(b && b.size <= IMG_MAX_BYTES){ best = b; lo = q; } else { hi = q; }
      }
      if(!best){ scale *= 0.85; continue; }          // ni con calidad mínima cabe: se achica un poco más
      last = { blob: best, w, h };
    }
    break;
  }
  const { blob, w, h } = last;
  // nunca devolver un archivo más pesado que el original si no hubo reducción de tamaño
  if(webFormat && w === W0 && h === H0 && blob.size >= file.size){
    return { file, width: W0, height: H0, original: file.size, changed: false };
  }
  const base = (file.name || 'foto').replace(/\.[^.]+$/, '');
  const ext = blob.type === 'image/webp' ? '.webp' : '.jpg';
  return { file: new File([blob], base + ext, { type: blob.type }), width: w, height: h, original: file.size, changed: true };
}

// Selección de foto en el formulario de producto: se optimiza al elegirla y se muestra
// vista previa + peso antes/después. Al guardar solo se sube el archivo ya optimizado.
let imgToken = 0, previewUrl = null;
function resetImagePreview(p){
  imgToken++;                                        // cancela cualquier optimización pendiente
  if(previewUrl){ URL.revokeObjectURL(previewUrl); previewUrl = null; }
  const box = document.getElementById('pImgBox'), img = document.getElementById('pImgPreview'), info = document.getElementById('pImgInfo');
  document.getElementById('pSaveBtn').disabled = false;
  info.textContent = ''; info.className = 'img-info';
  if(p && p.image_url){ img.src = p.image_url; info.textContent = 'Imagen actual'; box.classList.add('show'); }
  else { img.removeAttribute('src'); box.classList.remove('show'); }
}
async function onImageChosen(e){
  const input = e.target, f = input.files[0] || null;
  const token = ++imgToken;
  const box = document.getElementById('pImgBox'), img = document.getElementById('pImgPreview'), info = document.getElementById('pImgInfo');
  const btn = document.getElementById('pSaveBtn');
  state.imgFile = null;
  if(!f){
    const p = state.editId ? adminProduct(state.editId) : null;
    resetImagePreview(p); return;
  }
  btn.disabled = true;
  box.classList.add('show'); info.className = 'img-info'; info.textContent = 'Optimizando imagen...';
  try{
    const r = await optimizeImage(f);
    if(token !== imgToken) return;                   // eligió otra foto mientras tanto
    state.imgFile = r.file;
    if(previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(r.file); img.src = previewUrl;
    info.className = 'img-info ok';
    info.textContent = r.changed
      ? `Optimizada: ${fmtBytes(r.original)} → ${fmtBytes(r.file.size)} · ${r.width}×${r.height} px`
      : `La foto ya es liviana (${fmtBytes(r.file.size)} · ${r.width}×${r.height} px): se sube sin cambios.`;
  }catch(err){
    if(token !== imgToken) return;
    input.value = ''; state.imgFile = null;
    img.removeAttribute('src');
    info.className = 'img-info err';
    info.textContent = 'No se pudo leer esta imagen. Usa una foto JPG, PNG o WebP.';
  }finally{
    if(token === imgToken) btn.disabled = false;
  }
}


// ───────────────────────────── Fotos en Storage ────────────────────────
const BUCKET = 'product-images';
function storagePath(url){
  const m = String(url || '').match(/\/storage\/v1\/object\/public\/product-images\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
async function uploadToStorage(file, id){
  const ext = file.type === 'image/webp' ? '.webp' : file.type === 'image/png' ? '.png' : '.jpg';
  const path = `p/${id || 'nuevo'}-${Date.now()}${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: file.type, cacheControl: '31536000' });
  if(error) throw error;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}
// Al cambiar o borrar la foto de un producto se elimina el archivo viejo (si estaba en Storage)
async function removeStorageFile(url){
  const path = storagePath(url);
  if(path) try{ await sb.storage.from(BUCKET).remove([path]); }catch(e){ /* no es grave */ }
}

async function saveProduct(){
  const name = document.getElementById('pName').value.trim();
  const code = document.getElementById('pCode').value.trim() || null;
  const category = document.getElementById('pCat').value;
  const price = parseFloat(document.getElementById('pPrice').value) || 0;
  const stock = parseInt(document.getElementById('pStock').value) || 0;
  const featured = document.getElementById('pFeatured').checked;
  const msg = document.getElementById('pMsg');
  if(!name || !price){ msg.innerHTML = '<div class="msg err">Completa nombre y precio.</div>'; return; }
  const btn = document.getElementById('pSaveBtn'); btn.disabled = true; btn.textContent = 'Guardando...';
  const old = state.editId ? adminProduct(state.editId) : null;
  try{
    const payload = { name, code, category, price, stock, featured };
    if(state.imgFile) payload.image_url = await uploadToStorage(state.imgFile, state.editId);
    let error;
    if(state.editId) ({ error } = await sb.from('products').update(payload).eq('id', state.editId));
    else ({ error } = await sb.from('products').insert(payload));
    if(error) throw error;
    if(old && payload.image_url && old.image_url !== payload.image_url) removeStorageFile(old.image_url);
    state.editId = null; state.imgFile = null;
    closeModal('prodModal');
    await refreshAfterProductChange();
  }catch(err){
    msg.innerHTML = `<div class="msg err">${esc(friendlyError(err))}</div>`;
  }finally{
    btn.disabled = false; btn.textContent = 'Guardar producto';
  }
}
async function deleteProduct(id){
  if(!confirm('¿Eliminar este producto?')) return;
  const p = adminProduct(id);
  const { error } = await sb.from('products').delete().eq('id', id);
  if(error){ alert('Error: '+error.message); return; }
  if(p) removeStorageFile(p.image_url);
  await refreshAfterProductChange();
}

// Mueve las fotos guardadas como texto (data:) dentro de la base a Storage,
// reduciéndolas con el mismo optimizador. Se puede detener y retomar.
async function migratePhotos(){
  if(state.migrating){ state.migrating = false; return; }
  state.migrating = true;
  const failed = new Set();
  let done = 0;
  const say = t => { state.migMsg = t; const el = document.getElementById('migMsg'); if(el) el.textContent = t; };
  const btn = () => document.getElementById('migBtn');
  if(btn()) btn().textContent = 'Detener';
  try{
    while(state.migrating){
      let q = sb.from('products').select('id,image_url').like('image_url', 'data:%').order('id').limit(5);
      if(failed.size) q = q.not('id', 'in', '(' + [...failed].join(',') + ')');
      const { data, error } = await q;
      if(error) throw error;
      if(!data.length) break;
      for(const p of data){
        if(!state.migrating) break;
        try{
          const blob = await (await fetch(p.image_url)).blob();
          const r = await optimizeImage(new File([blob], 'p' + p.id, { type: blob.type || 'image/jpeg' }));
          const url = await uploadToStorage(r.file, p.id);
          const { error: e2 } = await sb.from('products').update({ image_url: url }).eq('id', p.id);
          if(e2) throw e2;
          const ap = adminProduct(p.id); if(ap) ap.image_url = url;
          done++;
        }catch(e){ failed.add(p.id); }
        say(`${done} fotos movidas${failed.size ? `, ${failed.size} con error` : ''}…`);
      }
    }
    say(state.migrating ? `Listo: ${done} fotos movidas a Storage${failed.size ? `. ${failed.size} no se pudieron mover (revisa esos productos y súbeles la foto de nuevo).` : '.'}` : `Detenido: ${done} fotos movidas. Puedes continuar cuando quieras.`);
  }catch(err){
    say('Se detuvo por un error: ' + friendlyError(err));
  }finally{
    state.migrating = false;
    await loadAdminProducts();
  }
}

// ───────────────────────────── Importar Excel ──────────────────────────
// Número desde una celda: si ya es número se usa tal cual; si es texto se limpia
// el formato colombiano ("$3.500", "1.200,50").
function numCell(v){
  if(typeof v === 'number') return v;
  const t = String(v == null ? '' : v).replace(/[$\s]/g, '');
  if(!t) return NaN;
  return parseFloat(t.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
}
function importPriceList(file){
  if(!file) return;
  const msg = document.getElementById('importMsg');
  state.importMsg = '';
  msg.innerHTML = '<div class="msg" style="background:var(--panel2);color:var(--muted)">Leyendo archivo...</div>';
  const reader = new FileReader();
  reader.onload = async (e)=>{
    try{
      const wb = XLSX.read(new Uint8Array(e.target.result), { type:'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header:1 });
      let curCatName = null;
      const newCats = new Set();
      const toUpsert = [];
      let skipped = 0, badStock = 0;
      for(let i=1;i<rows.length;i++){
        const r = rows[i]; if(!r || r.length===0) continue;
        const name = (r[0]||'').toString().trim();
        const code = (r[1]||'').toString().trim();
        const price = numCell(r[2]);
        // Columna D (opcional): existencias. Vacía = no se toca el stock.
        const stock = (r[3] == null || String(r[3]).trim() === '') ? null : Math.round(numCell(r[3]));
        if(!name) continue;
        if(!code){ curCatName = toTitle(name); newCats.add(curCatName); continue; }
        if(isNaN(price)){ skipped++; continue; }
        if(stock !== null && (isNaN(stock) || stock < 0)){ badStock++; }
        const row = { name: toTitle(name), code, category: curCatName || 'Sin categoría', price };
        if(stock !== null && !isNaN(stock) && stock >= 0) row.stock = stock;
        toUpsert.push(row);
      }
      msg.innerHTML = `<div class="msg" style="background:var(--panel2);color:var(--muted)">Importando ${toUpsert.length} productos...</div>`;
      const existing = new Set(state.categories);
      const catsToAdd = [...newCats].filter(c=>!existing.has(c)).map(name=>({name}));
      if(catsToAdd.length) await sb.from('categories').insert(catsToAdd);
      const BATCH = 200;
      const existingCodes = new Set(state.adminProducts.map(p => p.code).filter(Boolean));
      // Productos que ya existen: se actualizan nombre, categoría y precio; el stock solo
      // si la fila trae existencias. Los nuevos entran con sus existencias, o 15 si no traen.
      // (Se suben en grupos con las mismas columnas para no dejar el stock vacío.)
      const existingRows = toUpsert.filter(b => existingCodes.has(b.code));
      const exWithStock = existingRows.filter(b => b.stock != null);
      const exNoStock = existingRows.filter(b => b.stock == null);
      const newRows = toUpsert.filter(b => !existingCodes.has(b.code)).map(b => ({ ...b, stock: b.stock != null ? b.stock : 15 }));
      for(const batchRows of [exWithStock, exNoStock, newRows]){
        for(let i=0;i<batchRows.length;i+=BATCH){
          const { error } = await sb.from('products').upsert(batchRows.slice(i,i+BATCH), { onConflict:'code' });
          if(error){ throw error; }
        }
      }
      const partes = [`${existingRows.length} actualizados`, `${newRows.length} nuevos`];
      if(exWithStock.length || newRows.some(b => b.stock !== 15)) partes.push(`${exWithStock.length + newRows.filter(b => toUpsert.find(x => x.code === b.code).stock != null).length} con existencias del archivo`);
      if(exNoStock.length) partes.push(`${exNoStock.length} sin existencias en el archivo (stock sin cambios)`);
      if(skipped) partes.push(`${skipped} filas sin precio omitidas`);
      if(badStock) partes.push(`${badStock} con existencias no válidas (se ignoró ese valor)`);
      state.importMsg = `<div class="msg ok">Importación completa: ${partes.join(', ')}.</div>`;
      await refreshAfterProductChange();
    }catch(err){
      state.importMsg = `<div class="msg err">No se pudo completar la importación: ${esc(friendlyError(err))}</div>`;
      const m = document.getElementById('importMsg'); if(m) m.innerHTML = state.importMsg;
    }
  };
  reader.readAsArrayBuffer(file);
}

// ───────────────────────────── Avisos (toast) ───────────────────────────
let toastTimer = null;
function showToast(msg){
  let el = document.getElementById('toast');
  if(!el){ el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove('show'), 2200);
}

// ───────────────────────────── Carrito ─────────────────────────────────
function cartLine(p, qty){
  return { id: p.id, qty, name: p.name, code: p.code, price: Number(p.price), disp: p.disponible,
           img: /^https?:/.test(p.image_url || '') ? p.image_url : '' };
}
function addToCart(id, qty){
  if(!storeOpen()){ showToast('La tienda está cerrada en este momento'); return; }
  qty = Math.max(1, parseInt(qty, 10) || 1);
  const p = state.cache.get(id);
  if(!p) return;
  const c = loadCart();
  const it = c.find(x=>x.id===id);
  const have = it ? it.qty : 0;
  const add = Math.min(qty, (p.disponible || 0) - have);   // no pasar de lo disponible
  if(add < 1){ showToast('Ya tienes el máximo disponible de este producto'); return; }
  if(it){ Object.assign(it, cartLine(p, it.qty + add)); } else c.push(cartLine(p, add));
  saveCart(c); render();
  showToast(add + ' × ' + p.name + ' agregado al carrito ✓');
}
function removeFromCart(id){ saveCart(loadCart().filter(x=>x.id!==id)); render(); renderCartModal(); }

// Precio y disponibilidad actuales antes de mostrar el total o enviar el pedido
async function refreshCart(){
  const c = loadCart();
  if(!c.length) return [];
  let fresh;
  try{ fresh = await fetchProducts(c.map(x => x.id)); }catch(e){ return []; }
  const byId = new Map(fresh.map(p => [p.id, p]));
  const notes = [];
  const out = [];
  for(const it of c){
    const p = byId.get(it.id);
    if(!p || !(Number(p.price) > 0)){ notes.push(`«${it.name}» ya no está disponible y se quitó del carrito.`); continue; }
    const disp = p.disponible || 0;
    if(disp < 1){ notes.push(`«${p.name}» se agotó y se quitó del carrito.`); continue; }
    let qty = it.qty;
    if(qty > disp){ notes.push(`De «${p.name}» solo quedan ${disp}: ajustamos la cantidad.`); qty = disp; }
    if(Number(p.price) !== Number(it.price)) notes.push(`El precio de «${p.name}» cambió a ${fmt(priceFor(p.price))}.`);
    out.push(cartLine(p, qty));
  }
  saveCart(out);
  return notes;
}

function openCart(){
  renderCartModal();
  document.getElementById('cartNotice').innerHTML = '';
  openModal('cartModal');
  refreshCart().then(notes => {
    renderCartModal(); render();
    if(notes.length) document.getElementById('cartNotice').innerHTML = `<div class="msg err">${notes.map(esc).join('<br>')}</div>`;
  });
}
function cartStep(id, d){
  const c = loadCart();
  const it = c.find(x=>x.id===id);
  if(!it) return;
  const n = it.qty + d;
  if(n < 1) return;
  if(it.disp != null && n > it.disp){ showToast('Máximo disponible: ' + it.disp); return; }
  it.qty = n;
  saveCart(c); render(); renderCartModal();
}
function renderCartModal(){
  const c = loadCart();
  document.getElementById('cartItems').innerHTML = c.length ? c.map(it=>{
    const fp = priceFor(it.price);
    return `<div class="cart-line">
      <div class="cart-head"><div class="cart-name">${esc(it.name)}</div><div class="cart-total">${fmt(fp*it.qty)}</div></div>
      <div class="cart-sub">${it.code ? esc(it.code)+' · ' : ''}${fmt(fp)} c/u</div>
      <div class="cart-actions">
        <div class="stepper sm">
          <button onclick="cartStep(${it.id},-1)" ${it.qty<=1?'disabled':''} aria-label="Menos">−</button>
          <span>${it.qty}</span>
          <button onclick="cartStep(${it.id},1)" ${it.disp != null && it.qty>=it.disp?'disabled':''} aria-label="Más">+</button>
        </div>
        <button class="btn-outline btn-sm" onclick="removeFromCart(${it.id})">Quitar</button>
      </div></div>`;
  }).join('') : '<div class="empty">Carrito vacío.</div>';
  document.getElementById('cartTotal').textContent = fmt(c.reduce((s,it)=> s + priceFor(it.price)*it.qty, 0));
}

// ───────────────────────────── Ficha del producto ──────────────────────
// Cada producto tiene su enlace (#p-123) que se puede compartir.
function inCartQty(id){ const it = loadCart().find(x=>x.id===id); return it ? it.qty : 0; }
async function openProduct(id){
  let p = state.cache.get(id);
  if(!p){
    try{ [p] = await fetchProducts([id]); }catch(e){ p = null; }
    if(!p){ showToast('Ese producto ya no está disponible'); history.replaceState(null, '', location.pathname); return; }
  }
  state.qtyId = id; state.qty = 1;
  if(location.hash !== '#p-' + id) history.replaceState(null, '', '#p-' + id);
  renderQtyModal();
  document.getElementById('qtyRelated').innerHTML = '';
  openModal('qtyModal');
  loadRelated(p);
}
// Compatibilidad con llamadas anteriores
function openQty(id){ return openProduct(id); }
async function loadRelated(p){
  if(!p.category) return;
  let data = null;
  try{ ({ data } = await sb.rpc('catalog_page', { p_q: '', p_cat: p.category, p_sort: '', p_page: 1, p_size: 9 })); }catch(e){ return; }
  if(!data || state.qtyId !== p.id) return;
  const rel = (data.items || []).map(remember).filter(x => x.id !== p.id && x.disponible > 0).slice(0, 8);
  if(!rel.length) return;
  document.getElementById('qtyRelated').innerHTML = `<h3 class="rel-title">También en ${esc(p.category)}</h3><div class="rel">${rel.map(r =>
    `<button class="rel-card" onclick="openProduct(${r.id})"><span class="rel-img">${r.image_url ? `<img src="${esc(r.image_url)}" loading="lazy" alt="">` : NO_IMG}</span><span class="rel-name">${esc(r.name)}</span><b>${fmt(priceFor(r.price))}</b></button>`).join('')}</div>`;
}
function renderQtyModal(){
  const p = state.cache.get(state.qtyId);
  if(!p) return;
  const disp = p.disponible || 0;
  const have = inCartQty(p.id);
  const max = Math.max(0, disp - have);      // lo que todavía se puede agregar
  state.qty = Math.min(Math.max(1, state.qty || 1), Math.max(max, 1));
  const fp = priceFor(p.price);
  document.getElementById('qtyThumb').innerHTML = p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : NO_IMG;
  document.getElementById('qtyCat').textContent = p.category + (p.code ? ' · ' + p.code : '');
  document.getElementById('qtyName').textContent = p.name;
  document.getElementById('qtyPrice').textContent = fmt(fp);
  document.getElementById('qtyStock').textContent = disp < 1 ? 'Agotado' : (disp + (disp === 1 ? ' disponible' : ' disponibles') + (have ? ' · ya tienes ' + have + ' en el carrito' : ''));
  document.getElementById('qtyStock').className = 'stock' + (disp < 1 ? ' out' : '');
  document.getElementById('qtyInput').value = max > 0 ? state.qty : 0;
  document.getElementById('qtySub').textContent = fmt(fp * (max > 0 ? state.qty : 0));
  const btn = document.getElementById('qtyAddBtn');
  btn.disabled = max < 1 || !storeOpen();
  btn.textContent = !storeOpen() ? 'Tienda cerrada' : disp < 1 ? 'Agotado' : max < 1 ? 'Ya tienes el máximo en el carrito'
    : 'Agregar ' + state.qty + (state.qty === 1 ? ' unidad' : ' unidades') + ' al carrito';
  const ask = document.getElementById('qtyAsk');
  const wa = waLink(state.settings.whatsapp, `Hola ${storeName()}, ¿tienen disponible ${p.name}${p.code ? ' (código ' + p.code + ')' : ''}? ${siteUrl()}#p-${p.id}`);
  ask.style.display = wa ? '' : 'none';
  if(wa) ask.href = wa;
}
function qtyStep(d){ state.qty = (state.qty || 1) + d; renderQtyModal(); }
function qtyType(v){
  const n = parseInt(v, 10);
  if(isNaN(n)) return;                           // deja borrar el campo para escribir otro número
  state.qty = n;
  renderQtyModal();
}
function confirmAdd(){
  addToCart(state.qtyId, state.qty);
  closeModal('qtyModal');
}
async function shareProduct(){
  const p = state.cache.get(state.qtyId); if(!p) return;
  const url = siteUrl() + '#p-' + p.id;
  const text = `${p.name} — ${fmt(priceFor(p.price))} en ${storeName()}`;
  if(navigator.share){ try{ await navigator.share({ title: p.name, text, url }); return; }catch(e){ /* canceló */ } }
  window.open('https://wa.me/?text=' + encodeURIComponent(text + '\n' + url), '_blank');
}

// ───────────────────────────── Checkout ────────────────────────────────
function onEntregaChange(){
  const v = (document.querySelector('input[name="coEntrega"]:checked') || {}).value || 'recoger';
  document.getElementById('coDirBox').style.display = v === 'recoger' ? 'none' : '';
  document.getElementById('coCiudadBox').style.display = v === 'envio' ? '' : 'none';
}
async function openCheckout(){
  if(!storeOpen()){ alert(state.settings.mensaje_cerrada); return; }
  if(loadCart().length===0){ alert('Tu carrito está vacío.'); return; }
  const s = state.settings;
  document.getElementById('coEmail').value = state.profile ? state.profile.email : '';
  ['coWhatsapp','coNit','coDir','coCiudad','coNota','coWeb'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('optDomicilio').style.display = s.domicilio ? '' : 'none';
  document.getElementById('optEnvio').style.display = s.envio_nacional ? '' : 'none';
  document.getElementById('coEntregaBox').style.display = (s.domicilio || s.envio_nacional) ? '' : 'none';
  document.querySelector('input[name="coEntrega"][value="recoger"]').checked = true;
  onEntregaChange();
  const ms = mediosPago();
  document.getElementById('coMedioBox').style.display = ms.length ? '' : 'none';
  document.getElementById('coMedio').innerHTML = '<option value="">Lo defino después</option>' + ms.map(m => `<option>${esc(m.nombre)}</option>`).join('');
  document.getElementById('coMsg').innerHTML = '';
  closeModal('cartModal');
  openModal('checkoutModal');
}
async function confirmOrder(){
  const email = document.getElementById('coEmail').value.trim();
  // WhatsApp: solo dígitos (se aceptan espacios, guiones y +57 al escribirlo)
  const whatsapp = document.getElementById('coWhatsapp').value.replace(/\D/g, '');
  // NIT/CC: solo dígitos y guion (ej. 900123456-7); los puntos y espacios se quitan
  const nit = document.getElementById('coNit').value.replace(/[^0-9-]/g, '').slice(0, 20);
  const name = document.getElementById('coName').value.trim();
  const entrega = (document.querySelector('input[name="coEntrega"]:checked') || {}).value || 'recoger';
  const direccion = document.getElementById('coDir').value.trim();
  const ciudad = document.getElementById('coCiudad').value.trim();
  const medio = document.getElementById('coMedio').value;
  const nota = document.getElementById('coNota').value.trim();
  const msg = document.getElementById('coMsg');
  const err = t => { msg.innerHTML = `<div class="msg err">${esc(t)}</div>`; };
  if(!whatsapp) return err('Ingresa tu número de WhatsApp para poder contactarte.');
  if(whatsapp.length < 10 || whatsapp.length > 15) return err('Revisa tu WhatsApp: debe tener 10 dígitos (ej. 3001234567).');
  if(name.length < 3) return err('Escribe tu nombre.');
  const nitDigits = nit.replace(/-/g, '').length;
  if(!nit) return err('Ingresa tu NIT o CC para poder facturar tu pedido.');
  if(nitDigits < 5 || nitDigits > 15) return err('Revisa tu NIT o CC: debe tener entre 5 y 15 dígitos.');
  if(entrega !== 'recoger' && direccion.length < 5) return err('Escribe la dirección de entrega.');
  if(entrega === 'envio' && ciudad.length < 3) return err('Escribe la ciudad de envío.');
  const btn = document.getElementById('coSubmitBtn'); btn.disabled = true; btn.textContent = 'Enviando...';
  const notes = await refreshCart();
  if(notes.length){
    btn.disabled = false; btn.textContent = 'Enviar pedido';
    render();
    return err(notes.join(' ') + ' Revisa tu carrito y vuelve a enviar.');
  }
  // Solo mandamos id y cantidad: el servidor calcula precios, valida stock y total.
  const lines = loadCart().map(it => ({ product_id: it.id, qty: it.qty }));
  if(!lines.length){ btn.disabled = false; btn.textContent = 'Enviar pedido'; return err('Tu carrito está vacío.'); }
  let res;
  try{
    res = await sb.rpc('create_order', {
      p_name: name, p_email: email, p_whatsapp: whatsapp, p_items: lines, p_nit_cc: nit,
      p_entrega: entrega, p_direccion: direccion, p_ciudad: ciudad, p_nota: nota, p_medio: medio,
      p_trap: document.getElementById('coWeb').value,
    });
  }catch(e){ res = { error: e }; }
  btn.disabled = false; btn.textContent = 'Enviar pedido';
  if(res.error) return err('No se pudo enviar el pedido: ' + friendlyError(res.error));
  const order = res.data;
  saveCart([]);
  saveMyOrder(order);
  closeModal('checkoutModal');
  showOrderReceipt(order, email);
  render(); loadPage(false);
}

function orderWaText(o){
  const lines = [`Hola ${storeName()}, acabo de hacer el pedido *#${o.id}* en la tienda online:`, ''];
  (o.items || []).forEach(i => lines.push(`${i.qty} × ${i.name}${i.code ? ' (' + i.code + ')' : ''}`));
  lines.push('', `*Total: ${fmt(o.total)}*`, `Entrega: ${entregaTexto(o)}`);
  if(o.medio_pago) lines.push(`Pago: ${o.medio_pago}`);
  lines.push(`Nombre: ${o.name}`, `NIT/CC: ${o.nit_cc}`);
  if(o.token) lines.push('', `Estado del pedido: ${siteUrl()}#pedido-${o.token}`);
  return lines.join('\n');
}
function showOrderReceipt(order, email){
  renderReceipt({ id: order.id, token: order.token, items: order.items, total: order.total, name: order.name,
    nit: order.nit_cc, email, whatsapp: order.whatsapp, date: order.created_at,
    entrega: order.entrega, direccion: order.direccion, ciudad: order.ciudad, medio: order.medio_pago });
  const wa = waLink(state.settings.whatsapp, orderWaText(order));
  const a = document.getElementById('rcWa');
  a.style.display = wa ? '' : 'none';
  if(wa) a.href = wa;
  document.getElementById('rcNote').textContent = wa
    ? 'Envíanos tu pedido por WhatsApp para atenderlo más rápido. Te confirmamos disponibilidad y datos de pago.'
    : 'Te escribimos pronto por WhatsApp con los datos de pago.';
  document.getElementById('rcPay').innerHTML = payBoxHtml();
  openModal('receiptModal');
}

// ───────────────────────────── Mis pedidos / estado ────────────────────
function saveMyOrder(o){
  const list = lsGet(MY_ORDERS_KEY, []).filter(x => x && x.token !== o.token);
  list.unshift({ token: o.token, id: o.id, total: o.total, date: o.created_at });
  lsSet(MY_ORDERS_KEY, list.slice(0, 15));
}
function openMyOrders(){
  const list = lsGet(MY_ORDERS_KEY, []);
  document.getElementById('myOrdersList').innerHTML = list.length ? list.map(o =>
    `<button class="my-order" onclick="closeModal('myOrdersModal');openOrderStatus('${esc(o.token)}')"><b>Pedido #${o.id}</b><span>${new Date(o.date).toLocaleDateString('es-CO')}</span><span>${fmt(o.total)}</span></button>`).join('')
    : '<div class="empty">Aún no has hecho pedidos desde este dispositivo.</div>';
  openModal('myOrdersModal');
}
const PASOS = ['pendiente', 'confirmado', 'entregado'];
async function openOrderStatus(token){
  if(!token) return;
  closeModal('receiptModal');
  const body = document.getElementById('orderBody');
  body.innerHTML = '<div class="empty">Cargando pedido…</div>';
  if(location.hash !== '#pedido-' + token) history.replaceState(null, '', '#pedido-' + token);
  openModal('orderModal');
  let o = null;
  try{ const { data, error } = await sb.rpc('get_order', { p_token: token }); if(error) throw error; o = data; }
  catch(e){ body.innerHTML = `<div class="empty">${esc(friendlyError(e))}</div>`; return; }
  if(!o){ body.innerHTML = '<div class="empty">No encontramos ese pedido. Revisa el enlace.</div>'; return; }
  const idx = PASOS.indexOf(o.status);
  const steps = o.status === 'cancelado'
    ? '<div class="msg err">Este pedido fue cancelado. Si tienes dudas, escríbenos por WhatsApp.</div>'
    : `<ol class="osteps">${PASOS.map((s, i) => `<li class="${i <= idx ? 'done' : ''}">${ESTADOS[s]}</li>`).join('')}</ol>`;
  const wa = waLink(state.settings.whatsapp, orderWaText({ ...o, token }));
  body.innerHTML = `<h2>Pedido #${o.id}</h2>
    <p class="note">${new Date(o.created_at).toLocaleString('es-CO')} · ${esc(o.name || '')}</p>
    ${steps}
    ${o.status === 'pendiente' ? `<p class="note">Apartamos tus productos hasta el ${new Date(o.vence).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })}. Te escribimos por WhatsApp para confirmar.</p>` : ''}
    <ul class="olines">${(o.items || []).map(i => `<li><span>${i.qty} × ${esc(i.name)}${i.code ? ` <em>${esc(i.code)}</em>` : ''}</span><span>${fmt(i.qty * i.price)}</span></li>`).join('')}</ul>
    <div class="total-row"><b>Total</b><b>${fmt(o.total)}</b></div>
    <div class="ometa"><b>Entrega:</b> ${esc(entregaTexto(o))}${o.medio_pago ? ` · <b>Pago:</b> ${esc(o.medio_pago)}` : ''}</div>
    ${o.status === 'pendiente' ? payBoxHtml() : ''}
    ${wa ? `<a class="btn btn-wa" style="width:100%;margin-top:14px" href="${wa}" target="_blank" rel="noopener">Escribir a la tienda por WhatsApp</a>` : ''}`;
}
// ───────────────────────────── Comprobante (PNG) ───────────────────────
let lastReceipt = null;
// Logo precargado para dibujarlo en el comprobante
const LOGO_IMG = new Image();
LOGO_IMG.src = 'logo-jk2m.png';
function renderReceipt(order){
  lastReceipt = order;
  const canvas = document.getElementById('receiptCanvas');
  const W = 640;
  const pad = 32;
  const lineH = 44;
  // Alto = encabezado + líneas de contacto (nombre, correo, WhatsApp) + filas + total + pie + margen
  const contactLines = 1 + (order.nit ? 1 : 0) + (order.email ? 1 : 0) + (order.whatsapp ? 1 : 0) + (order.entrega ? 1 : 0) + (order.medio ? 1 : 0);
  const H = 294 + contactLines * 22 + order.items.length * lineH;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1B2026'; ctx.fillRect(0,0,W,H);
  // Logo (placa JK2M) a la izquierda; número y fecha del pedido a la derecha
  if(LOGO_IMG.complete && LOGO_IMG.naturalWidth){
    ctx.drawImage(LOGO_IMG, pad, 20, 176, 75);
  } else {
    ctx.fillStyle = '#99F903'; ctx.font = '700 30px Arial';
    ctx.fillText('JK2M REPUESTOS', pad, 64);
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = '#F2F4F6'; ctx.font = '700 20px Arial';
  ctx.fillText('Pedido #' + order.id, W - pad, 50);
  ctx.fillStyle = '#9AA4B0'; ctx.font = '14px Arial';
  ctx.fillText(new Date(order.date).toLocaleString('es-CO'), W - pad, 74);
  ctx.fillText('Comprobante de pedido', W - pad, 94);
  ctx.textAlign = 'left';

  ctx.strokeStyle = '#39424E'; ctx.beginPath(); ctx.moveTo(pad,110); ctx.lineTo(W-pad,110); ctx.stroke();

  ctx.fillStyle = '#F2F4F6'; ctx.font = '600 15px Arial';
  let y = 136;
  ctx.fillText('Cliente: ' + (order.name || 'Sin nombre'), pad, y); y += 22;
  if(order.nit) { ctx.fillText('NIT/CC: ' + order.nit, pad, y); y += 22; }
  if(order.email) { ctx.fillText('Correo: ' + order.email, pad, y); y += 22; }
  if(order.whatsapp) { ctx.fillText('WhatsApp: ' + order.whatsapp, pad, y); y += 22; }
  if(order.entrega) { ctx.fillText(fitText(ctx, 'Entrega: ' + entregaTexto(order), W - 2*pad), pad, y); y += 22; }
  if(order.medio) { ctx.fillText('Pago: ' + order.medio, pad, y); y += 22; }
  y += 10;
  ctx.strokeStyle = '#39424E'; ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(W-pad,y); ctx.stroke();
  y += 26;

  ctx.font = '600 13px Arial'; ctx.fillStyle = '#9AA4B0';
  ctx.fillText('PRODUCTO', pad, y);
  ctx.fillText('CANT.', W-220, y);
  ctx.fillText('SUBTOTAL', W-pad-90, y);
  y += 22;

  ctx.font = '14px Arial'; ctx.fillStyle = '#F2F4F6';
  order.items.forEach(it=>{
    const maxW = (W - 220) - pad - 16; // espacio hasta la columna CANT.
    let name = it.name;
    while(name.length > 1 && ctx.measureText(name).width > maxW){
      name = name.slice(0, -2).trimEnd() + '…';
    }
    ctx.fillText(name, pad, y);
    ctx.fillText(String(it.qty), W-220, y);
    ctx.fillText(fmt(it.price*it.qty), W-pad-90, y);
    // Segunda línea: código del producto (resaltado) y precio unitario
    let x = pad;
    ctx.font = '600 12px Arial';
    if(it.code){
      const codeTxt = 'Cód. ' + it.code;
      ctx.fillStyle = '#99F903'; ctx.fillText(codeTxt, x, y + 16);
      x += ctx.measureText(codeTxt).width;
      ctx.font = '12px Arial'; ctx.fillStyle = '#9AA4B0';
      ctx.fillText('  ·  ' + fmt(it.price) + ' c/u', x, y + 16);
    } else {
      ctx.font = '12px Arial'; ctx.fillStyle = '#9AA4B0';
      ctx.fillText(fmt(it.price) + ' c/u', x, y + 16);
    }
    ctx.font = '14px Arial'; ctx.fillStyle = '#F2F4F6';
    y += lineH;
  });

  y += 4;
  ctx.strokeStyle = '#39424E'; ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(W-pad,y); ctx.stroke();
  y += 34;
  ctx.font = '700 22px Arial'; ctx.fillStyle = '#99F903';
  ctx.fillText('TOTAL', pad, y);
  ctx.textAlign = 'right';
  ctx.fillText(fmt(order.total), W-pad, y);
  ctx.textAlign = 'left';
  y += 34;
  ctx.font = '13px Arial'; ctx.fillStyle = '#9AA4B0';
  ctx.fillText('Pendiente de confirmación — te contactaremos para el pago.', pad, y);
}
function downloadReceipt(){
  const canvas = document.getElementById('receiptCanvas');
  const a = document.createElement('a');
  a.download = 'pedido-' + (lastReceipt ? lastReceipt.id : '') + '.png';
  a.href = canvas.toDataURL('image/png');
  a.click();
}
async function shareReceipt(){
  const canvas = document.getElementById('receiptCanvas');
  const text = 'Pedido ' + storeName() + ' #' + (lastReceipt ? lastReceipt.id : '') + ' — Total ' + fmt(lastReceipt ? lastReceipt.total : 0);
  canvas.toBlob(async (blob)=>{
    const file = new File([blob], 'pedido.png', { type:'image/png' });
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      try{ await navigator.share({ files:[file], text }); return; }catch(e){ /* usuario canceló o falló: sigue al fallback */ }
    }
    downloadReceipt();
    window.open('https://wa.me/?text=' + encodeURIComponent(text + ' (adjunta la imagen descargada)'), '_blank');
  }, 'image/png');
}

function fitText(ctx, t, maxW){
  while(t.length > 1 && ctx.measureText(t).width > maxW) t = t.slice(0, -2).trimEnd() + '…';
  return t;
}
// ───────────────────────────── Arranque ────────────────────────────────
// Pantalla de carga: se muestra al menos 1,2 s (para que no parpadee) y se quita
// apenas el catálogo está listo, o aunque algo falle.
const SPLASH_MIN_MS = 1200;
function hideSplash(){
  const el = document.getElementById('splash');
  if(!el) return;
  setTimeout(()=>{
    el.classList.add('hide');
    setTimeout(()=> el.remove(), 450);
  }, Math.max(0, SPLASH_MIN_MS - performance.now()));
}
// Enlaces directos: #p-123 abre un producto; #pedido-TOKEN abre el estado de un pedido
function routeHash(){
  const h = location.hash;
  let m = h.match(/^#p-(\d+)$/);
  if(m){ openProduct(parseInt(m[1], 10)); return; }
  m = h.match(/^#pedido-([A-Za-z0-9]{16,64})$/);
  if(m) openOrderStatus(m[1]);
}
async function init(){
  try{
    document.getElementById('authSubmit').dataset.mode = 'login';
    await Promise.all([loadProfile(), loadSettings(), loadCategories()]);
    render();
    await loadPage(false);
    document.getElementById('loadingMsg').style.display = 'none';
    routeHash();
    window.addEventListener('hashchange', routeHash);
    sb.auth.onAuthStateChange(async (ev)=>{
      if(ev === 'INITIAL_SESSION' || ev === 'TOKEN_REFRESHED') return;
      await loadProfile(); render();
    });
  } finally {
    document.getElementById('loadingMsg').style.display = 'none';
    hideSplash();
  }
}
init();

// App instalable en el celular (y página sin conexión)
if('serviceWorker' in navigator && location.protocol === 'https:'){
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
