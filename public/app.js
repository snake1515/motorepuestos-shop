// MotoRepuestos — lógica de la tienda contra Supabase (DB + Auth + Storage).
// El carrito es lo único que sigue viviendo en localStorage (es solo de la
// visita actual); todo lo demás (catálogo, cuentas, pedidos) vive en Supabase.

const sb = window.supabase.createClient(window.SUPABASE_CONFIG.url, window.SUPABASE_CONFIG.anonKey);

const CART_KEY = 'eshop_cart';
function loadCart(){ try{ return JSON.parse(localStorage.getItem(CART_KEY))||[]; }catch(e){ return []; } }
function saveCart(c){ try{ localStorage.setItem(CART_KEY, JSON.stringify(c)); }catch(e){} }

let state = {
  products: [],
  categories: [],
  profile: null,     // perfil del usuario logueado (tipo, pct, is_admin)
  curCat: 'Todos',
  search: '',
  sort: 'default',
  adminSearch: '',
  view: 'shop',
  adminTab: 'prod',
  editId: null,
  imgFile: null,
};

function fmt(n){ return '$' + Math.round(n).toLocaleString('es-CO'); }
// Escapa texto que viene de la base de datos antes de meterlo en innerHTML (evita XSS)
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toTitle(s){
  const small=['de','del','la','las','el','los','y','en','a','con'];
  return (s||'').toString().trim().split(/\s+/).map((w,i)=>{
    const lw=w.toLowerCase();
    return (i>0 && small.includes(lw)) ? lw : (lw.charAt(0).toUpperCase()+lw.slice(1));
  }).join(' ');
}
function priceFor(base){
  if(!state.profile) return base;
  return Math.round(base * (1 - (state.profile.pct||0)/100));
}
function closeModal(id){ document.getElementById(id).classList.remove('show'); }

// ───────────────────────────── Carga de datos ─────────────────────────
async function loadCatalog(){
  const [{data:prods, error:e1}, {data:cats, error:e2}] = await Promise.all([
    sb.from('products').select('*').order('name'),
    sb.from('categories').select('name').order('name'),
  ]);
  if(e1) console.error(e1);
  if(e2) console.error(e2);
  state.products = prods || [];
  state.categories = (cats||[]).map(c=>c.name);
}

async function loadProfile(){
  const { data:{ session } } = await sb.auth.getSession();
  if(!session){ state.profile = null; return; }
  const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
  if(error){ state.profile = null; return; }
  state.profile = data;
}

// ───────────────────────────── Render ──────────────────────────────────
function renderCatSelect(){
  const cats=['Todos', ...state.categories];
  document.getElementById('catSelect').innerHTML = cats.map(c=>
    `<option value="${c}" ${c===state.curCat?'selected':''}>${c}</option>`).join('');
  document.getElementById('catTitle').textContent = state.curCat==='Todos' ? 'Catálogo' : state.curCat;
}
function setCat(c){ state.curCat=c; state.view='shop'; render(); }
function onSearch(v){ state.search = v.trim().toLowerCase(); render(); }
function onSortChange(v){ state.sort = v; render(); }
// Multibúsqueda: cada palabra escrita debe aparecer (en cualquier orden) en
// nombre, código o categoría del producto. Así "aceite 25w" sí encuentra
// "Aceite SL 25w 60" aunque esas palabras no estén pegadas.
function matchesSearch(p, query){
  if(!query) return true;
  const haystack = (p.name + ' ' + (p.code||'') + ' ' + (p.category||'')).toLowerCase();
  return query.trim().split(/\s+/).every(word => haystack.includes(word));
}

function renderGrid(){
  let list = state.products.filter(p => state.curCat==='Todos' || p.category===state.curCat);
  if(state.search) list = list.filter(p => matchesSearch(p, state.search));
  if(state.sort==='price_asc') list = [...list].sort((a,b)=>priceFor(a.price)-priceFor(b.price));
  else if(state.sort==='price_desc') list = [...list].sort((a,b)=>priceFor(b.price)-priceFor(a.price));
  const admin = state.profile && state.profile.is_admin;
  document.getElementById('grid').innerHTML = list.length ? list.map(p=>{
    const fp = priceFor(p.price);
    const showBase = state.profile && fp !== p.price;
    return `<div class="card">
      <div class="thumb clickable" onclick="openQty(${p.id})">${p.image_url ? `<img src="${esc(p.image_url)}" loading="lazy" alt="">` : 'Sin imagen'}</div>
      <div class="card-body">
        <div class="cat-tag">${esc(p.category)}${p.code ? ' · '+esc(p.code) : ''}</div>
        <div class="pname clickable" onclick="openQty(${p.id})">${esc(p.name)}</div>
        ${showBase ? `<div class="price-base">${fmt(p.price)}</div>` : ''}
        <div class="price">${fmt(fp)}</div>
        <div class="stock">Stock: ${p.stock}</div>
        <button class="btn btn-sm" style="margin-top:6px" ${p.stock<1?'disabled':''} onclick="openQty(${p.id})">${p.stock<1?'Agotado':'Agregar al carrito'}</button>
        ${admin ? `<button class="btn-outline btn-sm" onclick="deleteProduct(${p.id})">Eliminar</button>` : ''}
      </div></div>`;
  }).join('') : '<div class="empty">No hay productos que coincidan.</div>';
}

function renderAcct(){
  const btn = document.getElementById('acctBtn');
  btn.textContent = state.profile ? `${state.profile.email.split('@')[0]} · salir` : 'Ingresar';
  document.getElementById('passBtn').style.display = state.profile ? '' : 'none';
}
async function onAcctClick(){
  if(state.profile){ await sb.auth.signOut(); state.profile=null; state.view='shop'; render(); }
  else document.getElementById('authModal').classList.add('show');
}

function renderAdminBar(){
  const bar = document.getElementById('adminBar');
  if(!state.profile || !state.profile.is_admin){ bar.innerHTML=''; return; }
  bar.innerHTML = `<div class="row" style="margin-bottom:16px"><span class="badge">Modo administrador</span>
    <button class="btn btn-sm" onclick="toggleAdmin()">${state.view==='admin'?'Volver a la tienda':'Abrir panel de administración'}</button></div>`;
}
function toggleAdmin(){ state.view = state.view==='admin' ? 'shop' : 'admin'; render(); }

function renderAdminPanel(){
  const el = document.getElementById('adminPanel');
  const tabs = `<div class="tabs"><button class="${state.adminTab==='prod'?'active':''}" onclick="state.adminTab='prod';render()">Productos (${state.products.length})</button><button class="${state.adminTab==='cat'?'active':''}" onclick="state.adminTab='cat';render()">Categorías</button><button onclick="openUsersAdmin()">Clientes</button><button onclick="openOrders()">Pedidos</button></div>`;
  let body='';
  if(state.adminTab==='prod'){
    let ps = state.products;
    if(state.adminSearch) ps = ps.filter(p=>matchesSearch(p, state.adminSearch));
    body = `<div class="row" style="margin-bottom:12px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="openProdModal(null)">+ Nuevo producto</button>
      <button class="btn-outline btn-sm" onclick="document.getElementById('xlsxImport').click()">Importar lista de precios (Excel)</button>
      <input type="file" id="xlsxImport" accept=".xlsx,.xls" style="display:none" onchange="importPriceList(this.files[0])">
      <input placeholder="Buscar producto o código..." value="${state.adminSearch}" oninput="state.adminSearch=this.value.trim().toLowerCase();render()" style="flex:1;min-width:180px">
      </div>
      <div id="importMsg"></div>
      <div style="overflow-x:auto;max-height:65vh;overflow-y:auto"><table><tr><th></th><th>Producto</th><th>Código</th><th>Categoría</th><th>Precio base</th><th>Stock</th><th></th></tr>`
      + ps.slice(0,300).map(p=>`<tr><td style="width:52px"><div class="thumb" style="width:44px;height:44px">${p.image_url?`<img src="${p.image_url}">`:''}</div></td><td>${p.name}</td><td style="color:var(--muted);font-size:12px">${p.code||''}</td><td>${p.category}</td><td>${fmt(p.price)}</td><td>${p.stock}</td><td style="white-space:nowrap"><button class="btn btn-sm" onclick="openProdModal(${p.id})">Editar</button> <button class="btn-outline btn-sm" onclick="deleteProduct(${p.id})">Eliminar</button></td></tr>`).join('')
      + `</table></div>`
      + (ps.length>300 ? `<div style="color:var(--muted);font-size:13px;margin-top:8px">Mostrando 300 de ${ps.length}. Usa el buscador para acotar.</div>` : '');
  } else {
    const ps = state.products;
    body = `<div style="margin-bottom:12px"><button class="btn btn-sm" onclick="promptCategory()">+ Nueva categoría</button></div><div style="overflow-x:auto;max-height:65vh;overflow-y:auto"><table><tr><th>Categoría</th><th>Productos</th><th></th></tr>`
      + state.categories.map((c,i)=>`<tr><td>${c}</td><td>${ps.filter(p=>p.category===c).length}</td><td style="white-space:nowrap"><button class="btn btn-sm" onclick="renameCategory(${i})">Renombrar</button> <button class="btn-outline btn-sm" onclick="deleteCategory(${i})">Eliminar</button></td></tr>`).join('')
      + `</table></div>`;
  }
  el.innerHTML = tabs + body;
}

function render(){
  const admin = state.view==='admin' && state.profile && state.profile.is_admin;
  document.getElementById('grid').style.display = admin ? 'none' : '';
  document.getElementById('catTitle').style.display = admin ? 'none' : '';
  document.getElementById('adminPanel').style.display = admin ? 'block' : 'none';
  renderCatSelect(); renderGrid(); renderAcct(); renderAdminBar();
  if(admin) renderAdminPanel();
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
    if(error){ msg.innerHTML = `<div class="msg err">${error.message}</div>`; return; }
    if(data.user && !data.session){
      msg.innerHTML = '<div class="msg ok">Cuenta creada. Revisa tu correo para confirmarla y luego ingresa.</div>';
      switchAuth('login');
      return;
    }
    // sesión activa inmediatamente (confirmación de correo desactivada)
    await sb.from('profiles').insert({ id: data.user.id, email, tipo:'Detalle', pct:0, is_admin:false });
    msg.innerHTML = '<div class="msg ok">Cuenta creada. El precio que verás depende del tipo de cliente que te asigne la tienda.</div>';
  } else {
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    if(error){ msg.innerHTML = `<div class="msg err">${error.message}</div>`; return; }
  }
  await loadProfile();
  setTimeout(()=>{ closeModal('authModal'); render(); }, 500);
}

async function changePass(){
  const n = prompt('Nueva contraseña (mínimo 6 caracteres):');
  if(!n) return;
  const { error } = await sb.auth.updateUser({ password: n });
  alert(error ? 'No se pudo actualizar: '+error.message : 'Contraseña actualizada.');
}

// ───────────────────────────── Admin: clientes ─────────────────────────
async function openUsersAdmin(){
  const { data: us, error } = await sb.from('profiles').select('*').order('email');
  if(error){ alert('No se pudo cargar la lista de clientes: '+error.message); return; }
  let html = `<h2>Clientes</h2>
  <p style="color:var(--muted);font-size:13px">Para crear una cuenta de cliente nueva, pídele que se registre desde "Crear cuenta" en la tienda; luego edítale aquí el tipo y el % de descuento.</p>
  <table><tr><th>Correo</th><th>Tipo</th><th>% Desc.</th><th></th></tr>`;
  us.filter(u=>!u.is_admin).forEach(u=>{
    html += `<tr><td>${u.email}</td>
      <td><input id="tipo_${u.id}" value="${u.tipo}" style="width:110px"></td>
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
async function openOrders(){
  const { data: os, error } = await sb.from('orders').select('*, order_items(*)').order('created_at', { ascending:false }).limit(100);
  if(error){ alert('No se pudo cargar los pedidos: '+error.message); return; }
  const html = '<h2>Pedidos recibidos</h2>' + (os.length ? os.map(o=>{
      const contact = [o.nit_cc ? 'NIT/CC '+o.nit_cc : null, o.user_email, o.whatsapp ? '📱 '+o.whatsapp : null].filter(Boolean).join(' · ') || 'Sin contacto';
      return `<div class="card" style="padding:12px;margin-bottom:10px">
      <div class="row" style="justify-content:space-between;flex-wrap:wrap"><b>${esc(o.customer_name||'Sin nombre')} · ${esc(contact)}</b><span class="badge">${new Date(o.created_at).toLocaleString('es-CO')}</span></div>
      <div style="font-size:14px;color:var(--muted);margin:6px 0">${(o.order_items||[]).map(i=>esc(i.name)+(i.code ? ' ['+esc(i.code)+']' : '')+' x'+i.qty).join(', ')}</div>
      <b style="color:var(--accent)">Total: ${fmt(o.total)}</b></div>`;
    }).join('') : '<div class="empty">Aún no hay pedidos.</div>');
  const wrap = document.createElement('div');
  wrap.className='modal-bg show'; wrap.id='ordersModal';
  wrap.innerHTML = `<div class="modal wide"><button class="close-x" onclick="document.getElementById('ordersModal').remove()">✕</button>${html}</div>`;
  document.body.appendChild(wrap);
}

// ───────────────────────────── Admin: categorías ───────────────────────
async function promptCategory(){
  const c = (prompt('Nombre de la nueva categoría:')||'').trim();
  if(!c) return;
  const { error } = await sb.from('categories').insert({ name: toTitle(c) });
  if(error){ alert('Error: '+error.message); return; }
  await loadCatalog(); render();
}
async function renameCategory(i){
  const old = state.categories[i];
  const n = (prompt('Nuevo nombre:', old)||'').trim();
  if(!n || n===old) return;
  await sb.from('categories').update({ name:n }).eq('name', old);
  await sb.from('products').update({ category:n }).eq('category', old);
  if(state.curCat===old) state.curCat=n;
  await loadCatalog(); render();
}
async function deleteCategory(i){
  const c = state.categories[i];
  if(state.products.some(p=>p.category===c)){ alert('Esta categoría tiene productos. Muévelos o elimínalos primero.'); return; }
  if(!confirm('¿Eliminar la categoría '+c+'?')) return;
  await sb.from('categories').delete().eq('name', c);
  if(state.curCat===c) state.curCat='Todos';
  await loadCatalog(); render();
}

// ───────────────────────────── Admin: productos ────────────────────────
document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('pImg').addEventListener('change', e=>{ state.imgFile = e.target.files[0] || null; });
});
function openProdModal(id){
  state.editId = id; state.imgFile = null;
  document.getElementById('pCat').innerHTML = state.categories.map(c=>`<option>${c}</option>`).join('');
  const p = id ? state.products.find(x=>x.id===id) : null;
  document.getElementById('pTitle').textContent = p ? 'Editar producto' : 'Nuevo producto';
  document.getElementById('pName').value = p ? p.name : '';
  document.getElementById('pCode').value = p ? (p.code||'') : '';
  document.getElementById('pPrice').value = p ? p.price : '';
  document.getElementById('pStock').value = p ? p.stock : 10;
  document.getElementById('pImg').value = '';
  document.getElementById('pMsg').innerHTML = '';
  if(p) document.getElementById('pCat').value = p.category;
  document.getElementById('prodModal').classList.add('show');
}
async function uploadImageIfNeeded(){
  if(!state.imgFile) return undefined; // sin cambios
  const file = state.imgFile;
  const path = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.\-_]/g,'_')}`;
  const { error } = await sb.storage.from('product-images').upload(path, file, { upsert:true });
  if(error) throw error;
  const { data } = sb.storage.from('product-images').getPublicUrl(path);
  return data.publicUrl;
}
async function saveProduct(){
  const name = document.getElementById('pName').value.trim();
  const code = document.getElementById('pCode').value.trim() || null;
  const category = document.getElementById('pCat').value;
  const price = parseFloat(document.getElementById('pPrice').value) || 0;
  const stock = parseInt(document.getElementById('pStock').value) || 0;
  const msg = document.getElementById('pMsg');
  if(!name || !price){ msg.innerHTML = '<div class="msg err">Completa nombre y precio.</div>'; return; }
  const btn = document.getElementById('pSaveBtn'); btn.disabled = true; btn.textContent = 'Guardando...';
  try{
    const image_url = await uploadImageIfNeeded();
    const payload = { name, code, category, price, stock };
    if(image_url !== undefined) payload.image_url = image_url;
    let error;
    if(state.editId) ({ error } = await sb.from('products').update(payload).eq('id', state.editId));
    else ({ error } = await sb.from('products').insert(payload));
    if(error) throw error;
    state.editId = null; state.imgFile = null;
    closeModal('prodModal');
    await loadCatalog(); render();
  }catch(err){
    msg.innerHTML = `<div class="msg err">${err.message}</div>`;
  }finally{
    btn.disabled = false; btn.textContent = 'Guardar producto';
  }
}
async function deleteProduct(id){
  if(!confirm('¿Eliminar este producto?')) return;
  const { error } = await sb.from('products').delete().eq('id', id);
  if(error){ alert('Error: '+error.message); return; }
  await loadCatalog(); render();
}

// ───────────────────────────── Importar Excel ──────────────────────────
function importPriceList(file){
  if(!file) return;
  const msg = document.getElementById('importMsg');
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
      let skipped = 0;
      for(let i=1;i<rows.length;i++){
        const r = rows[i]; if(!r || r.length===0) continue;
        const name = (r[0]||'').toString().trim();
        const code = (r[1]||'').toString().trim();
        const price = parseFloat(r[2]);
        if(!name) continue;
        if(!code){ curCatName = toTitle(name); newCats.add(curCatName); continue; }
        if(isNaN(price)){ skipped++; continue; }
        toUpsert.push({ name: toTitle(name), code, category: curCatName || 'Sin categoría', price, stock: 15 });
      }
      msg.innerHTML = `<div class="msg" style="background:var(--panel2);color:var(--muted)">Importando ${toUpsert.length} productos...</div>`;
      // categorías nuevas primero
      const existing = new Set(state.categories);
      const catsToAdd = [...newCats].filter(c=>!existing.has(c)).map(name=>({name}));
      if(catsToAdd.length) await sb.from('categories').insert(catsToAdd);
      // upsert por código, en lotes
      const BATCH = 200;
      let updated=0, created=0;
      const { data: existingProducts } = await sb.from('products').select('code').not('code','is',null);
      const existingCodes = new Set((existingProducts||[]).map(p=>p.code));
      for(let i=0;i<toUpsert.length;i+=BATCH){
        const batch = toUpsert.slice(i,i+BATCH);
        const { error } = await sb.from('products').upsert(batch, { onConflict:'code' });
        if(error){ throw error; }
        batch.forEach(b=> existingCodes.has(b.code) ? updated++ : created++);
      }
      msg.innerHTML = `<div class="msg ok">Importación completa: ${updated} actualizados, ${created} nuevos, ${skipped} filas sin precio omitidas.</div>`;
      await loadCatalog(); render();
    }catch(err){
      msg.innerHTML = `<div class="msg err">No se pudo completar la importación: ${err.message}</div>`;
    }
  };
  reader.readAsArrayBuffer(file);
}

// ───────────────────────────── Avisos (toast) ───────────────────────────
let toastTimer = null;
function showToast(msg){
  let el = document.getElementById('toast');
  if(!el){
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> el.classList.remove('show'), 2200);
}

// ───────────────────────────── Carrito y checkout ──────────────────────
function addToCart(id, qty){
  qty = Math.max(1, parseInt(qty, 10) || 1);
  const p = state.products.find(x=>x.id===id);
  if(!p) return;
  const c = loadCart();
  const it = c.find(x=>x.id===id);
  const have = it ? it.qty : 0;
  const add = Math.min(qty, p.stock - have);   // no pasar del stock disponible
  if(add < 1){ showToast('Ya tienes el máximo disponible de este producto'); return; }
  if(it) it.qty += add; else c.push({ id, qty: add });
  saveCart(c); render();
  showToast(add + ' × ' + p.name + ' agregado al carrito ✓');
}
function removeFromCart(id){ saveCart(loadCart().filter(x=>x.id!==id)); render(); renderCartModal(); }

// ───────────────────────────── Modal de cantidad ───────────────────────
function inCartQty(id){ const it = loadCart().find(x=>x.id===id); return it ? it.qty : 0; }
function openQty(id){
  const p = state.products.find(x=>x.id===id);
  if(!p || p.stock < 1) return;
  state.qtyId = id;
  state.qty = 1;
  renderQtyModal();
  document.getElementById('qtyModal').classList.add('show');
}
function renderQtyModal(){
  const p = state.products.find(x=>x.id===state.qtyId);
  if(!p) return;
  const have = inCartQty(p.id);
  const max = Math.max(0, p.stock - have);      // lo que todavía se puede agregar
  state.qty = Math.min(Math.max(1, state.qty || 1), Math.max(max, 1));
  const fp = priceFor(p.price);
  document.getElementById('qtyThumb').innerHTML = p.image_url ? `<img src="${esc(p.image_url)}" alt="">` : 'Sin imagen';
  document.getElementById('qtyCat').textContent = p.category + (p.code ? ' · ' + p.code : '');
  document.getElementById('qtyName').textContent = p.name;
  document.getElementById('qtyPrice').textContent = fmt(fp);
  document.getElementById('qtyStock').textContent = 'Stock: ' + p.stock + (have ? ' · ya tienes ' + have + ' en el carrito' : '');
  document.getElementById('qtyInput').value = max > 0 ? state.qty : 0;
  document.getElementById('qtySub').textContent = fmt(fp * (max > 0 ? state.qty : 0));
  const btn = document.getElementById('qtyAddBtn');
  btn.disabled = max < 1;
  btn.textContent = max < 1 ? 'Ya tienes el máximo en el carrito' : 'Agregar ' + state.qty + (state.qty === 1 ? ' unidad' : ' unidades') + ' al carrito';
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

// ───────────────────────────── Carrito (modal) ─────────────────────────
function openCart(){ renderCartModal(); document.getElementById('cartModal').classList.add('show'); }
function cartStep(id, d){
  const c = loadCart();
  const it = c.find(x=>x.id===id);
  const p = state.products.find(x=>x.id===id);
  if(!it || !p) return;
  const n = it.qty + d;
  if(n < 1) return;
  if(n > p.stock){ showToast('Máximo disponible: ' + p.stock); return; }
  it.qty = n;
  saveCart(c); render(); renderCartModal();
}
function renderCartModal(){
  const c = loadCart();
  const rows = c.map(it=>{
    const p = state.products.find(x=>x.id===it.id); if(!p) return '';
    const fp = priceFor(p.price);
    return `<div class="cart-line">
      <div class="cart-head"><div class="cart-name">${esc(p.name)}</div><div class="cart-total">${fmt(fp*it.qty)}</div></div>
      <div class="cart-sub">${p.code ? esc(p.code)+' · ' : ''}${fmt(fp)} c/u</div>
      <div class="cart-actions">
        <div class="stepper sm">
          <button onclick="cartStep(${p.id},-1)" ${it.qty<=1?'disabled':''} aria-label="Menos">−</button>
          <span>${it.qty}</span>
          <button onclick="cartStep(${p.id},1)" ${it.qty>=p.stock?'disabled':''} aria-label="Más">+</button>
        </div>
        <button class="btn-outline btn-sm" onclick="removeFromCart(${p.id})">Quitar</button>
      </div></div>`;
  }).join('');
  document.getElementById('cartItems').innerHTML = rows || '<div class="empty">Carrito vacío.</div>';
  const total = c.reduce((s,it)=>{ const p = state.products.find(x=>x.id===it.id); return s + (p ? priceFor(p.price)*it.qty : 0); }, 0);
  document.getElementById('cartTotal').textContent = fmt(total);
}
function openCheckout(){
  if(loadCart().length===0){ alert('Tu carrito está vacío.'); return; }
  document.getElementById('coEmail').value = state.profile ? state.profile.email : '';
  document.getElementById('coWhatsapp').value = '';
  document.getElementById('coNit').value = '';
  document.getElementById('coMsg').innerHTML = '';
  closeModal('cartModal');
  document.getElementById('checkoutModal').classList.add('show');
}
async function confirmOrder(){
  const email = document.getElementById('coEmail').value.trim();
  const whatsapp = document.getElementById('coWhatsapp').value.trim();
  // NIT/CC: solo dígitos y guion (ej. 900123456-7); los puntos y espacios se quitan
  const nit = document.getElementById('coNit').value.replace(/[^0-9-]/g, '').slice(0, 20);
  const name = document.getElementById('coName').value.trim();
  const msg = document.getElementById('coMsg');
  if(!email && !whatsapp){ msg.innerHTML = '<div class="msg err">Déjanos al menos un dato de contacto: correo o WhatsApp.</div>'; return; }
  const nitDigits = nit.replace(/-/g, '').length;
  if(!nit){ msg.innerHTML = '<div class="msg err">Ingresa tu NIT o CC para poder facturar tu pedido.</div>'; return; }
  if(nitDigits < 5 || nitDigits > 15){ msg.innerHTML = '<div class="msg err">Revisa tu NIT o CC: debe tener entre 5 y 15 dígitos.</div>'; return; }
  // Solo mandamos id y cantidad: el servidor calcula precios y total (create_order en Supabase).
  const lines = loadCart()
    .filter(it => state.products.some(p => p.id === it.id))
    .map(it => ({ product_id: it.id, qty: it.qty }));
  if(!lines.length){ msg.innerHTML = '<div class="msg err">Tu carrito está vacío.</div>'; return; }
  const btn = document.getElementById('coSubmitBtn'); btn.disabled = true; btn.textContent = 'Enviando...';
  const { data: order, error } = await sb.rpc('create_order', {
    p_name: name, p_email: email, p_whatsapp: whatsapp, p_items: lines, p_nit_cc: nit
  });
  btn.disabled = false; btn.textContent = 'Enviar pedido';
  if(error){ msg.innerHTML = `<div class="msg err">No se pudo enviar el pedido: ${error.message}</div>`; return; }
  saveCart([]);
  closeModal('checkoutModal');
  renderReceipt({ id: order.id, items: order.items, total: order.total, name, nit: order.nit_cc, email, whatsapp, date: order.created_at });
  document.getElementById('receiptModal').classList.add('show');
  render();
}

// ───────────────────────────── Comprobante (PNG) ───────────────────────
let lastReceipt = null;
function renderReceipt(order){
  lastReceipt = order;
  const canvas = document.getElementById('receiptCanvas');
  const W = 640;
  const pad = 32;
  const lineH = 44;
  // Alto = encabezado + líneas de contacto (nombre, correo, WhatsApp) + filas + total + pie + margen
  const contactLines = 1 + (order.nit ? 1 : 0) + (order.email ? 1 : 0) + (order.whatsapp ? 1 : 0);
  const H = 294 + contactLines * 22 + order.items.length * lineH;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#1B1D21'; ctx.fillRect(0,0,W,H);
  ctx.fillStyle = '#E8871E';
  ctx.font = '700 30px Arial';
  ctx.fillText('MOTOREPUESTOS', pad, 50);
  ctx.fillStyle = '#9599A2';
  ctx.font = '14px Arial';
  ctx.fillText('Comprobante de pedido #' + order.id, pad, 74);
  ctx.fillText(new Date(order.date).toLocaleString('es-CO'), pad, 94);

  ctx.strokeStyle = '#3A3E45'; ctx.beginPath(); ctx.moveTo(pad,110); ctx.lineTo(W-pad,110); ctx.stroke();

  ctx.fillStyle = '#EDEDEF'; ctx.font = '600 15px Arial';
  let y = 136;
  ctx.fillText('Cliente: ' + (order.name || 'Sin nombre'), pad, y); y += 22;
  if(order.nit) { ctx.fillText('NIT/CC: ' + order.nit, pad, y); y += 22; }
  if(order.email) { ctx.fillText('Correo: ' + order.email, pad, y); y += 22; }
  if(order.whatsapp) { ctx.fillText('WhatsApp: ' + order.whatsapp, pad, y); y += 22; }
  y += 10;
  ctx.strokeStyle = '#3A3E45'; ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(W-pad,y); ctx.stroke();
  y += 26;

  ctx.font = '600 13px Arial'; ctx.fillStyle = '#9599A2';
  ctx.fillText('PRODUCTO', pad, y);
  ctx.fillText('CANT.', W-220, y);
  ctx.fillText('SUBTOTAL', W-pad-90, y);
  y += 22;

  ctx.font = '14px Arial'; ctx.fillStyle = '#EDEDEF';
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
      ctx.fillStyle = '#E8871E'; ctx.fillText(codeTxt, x, y + 16);
      x += ctx.measureText(codeTxt).width;
      ctx.font = '12px Arial'; ctx.fillStyle = '#9599A2';
      ctx.fillText('  ·  ' + fmt(it.price) + ' c/u', x, y + 16);
    } else {
      ctx.font = '12px Arial'; ctx.fillStyle = '#9599A2';
      ctx.fillText(fmt(it.price) + ' c/u', x, y + 16);
    }
    ctx.font = '14px Arial'; ctx.fillStyle = '#EDEDEF';
    y += lineH;
  });

  y += 4;
  ctx.strokeStyle = '#3A3E45'; ctx.beginPath(); ctx.moveTo(pad,y); ctx.lineTo(W-pad,y); ctx.stroke();
  y += 34;
  ctx.font = '700 22px Arial'; ctx.fillStyle = '#E8871E';
  ctx.fillText('TOTAL', pad, y);
  ctx.textAlign = 'right';
  ctx.fillText(fmt(order.total), W-pad, y);
  ctx.textAlign = 'left';
  y += 34;
  ctx.font = '13px Arial'; ctx.fillStyle = '#9599A2';
  ctx.fillText('Pendiente de pago — te contactaremos para coordinarlo.', pad, y);
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
  const text = 'Pedido MotoRepuestos #' + (lastReceipt ? lastReceipt.id : '') + ' — Total ' + fmt(lastReceipt ? lastReceipt.total : 0);
  canvas.toBlob(async (blob)=>{
    const file = new File([blob], 'pedido.png', { type:'image/png' });
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      try{ await navigator.share({ files:[file], text }); return; }catch(e){ /* usuario canceló o falló: sigue al fallback */ }
    }
    downloadReceipt();
    window.open('https://wa.me/?text=' + encodeURIComponent(text + ' (adjunta la imagen descargada)'), '_blank');
  }, 'image/png');
}

// ───────────────────────────── Arranque ────────────────────────────────
async function init(){
  document.getElementById('authSubmit').dataset.mode = 'login';
  await loadProfile();
  await loadCatalog();
  document.getElementById('loadingMsg').style.display = 'none';
  render();
  sb.auth.onAuthStateChange(async ()=>{ await loadProfile(); render(); });
}
init();











