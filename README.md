# MotoRepuestos — tienda online

Sitio estático (HTML/CSS/JS, sin build) + Supabase como base de datos,
autenticación y almacenamiento de imágenes. Desplegable gratis en Render.

Incluye el catálogo real de JK2M: 54 categorías y ~900 productos con sus
precios de octubre, y ~390 con foto ya emparejada desde el catálogo en PDF.

## 1. Crear el proyecto en Supabase

1. Entra a https://supabase.com, crea una cuenta y un proyecto nuevo (gratis).
2. Ve a **Project Settings → API** y copia:
   - `Project URL`
   - `anon public` key
3. Ve a **SQL Editor → New query**, pega el contenido de `supabase/schema.sql`
   y ejecútalo. Crea las tablas, la seguridad (RLS) y el bucket de imágenes.
4. En una nueva consulta, pega y ejecuta `supabase/seed.sql`. Esto carga los
   ~900 productos reales con sus precios y fotos. El archivo pesa ~1.5 MB:
   si el editor web se siente lento, también puedes correrlo con:
   ```
   psql "postgresql://postgres:TU-PASSWORD@db.TU-PROYECTO.supabase.co:5432/postgres" -f supabase/seed.sql
   ```
   (la cadena de conexión está en Project Settings → Database).
5. En **Authentication → Providers → Email**, si quieres que los clientes
   puedan entrar inmediatamente después de registrarse (sin confirmar
   correo), desactiva "Confirm email". Si lo dejas activado, el cliente
   deberá confirmar su correo antes de poder iniciar sesión.

## 2. Configurar el frontend con tu proyecto

1. Dentro de `public/`, copia `config.example.js` como `config.js`.
2. Edita `public/config.js` y pon tu `Project URL` y tu `anon key`.
   (La anon key es pública por diseño — lo que la protege es la seguridad
   a nivel de fila que ya quedó configurada en `schema.sql`.)
3. `config.js` está en `.gitignore` para que no subas credenciales por
   accidente a un repo público; si tu repo es privado puedes quitarlo del
   `.gitignore` y commitearlo para que Render lo sirva tal cual.

## 3. Volverte administrador

1. Despliega el sitio (paso 4) o ábrelo localmente (`index.html` con
   Live Server, por ejemplo).
2. Crea tu cuenta normal desde el botón **Ingresar → Crear cuenta**.
3. En Supabase, **SQL Editor**, corre (cambia el correo):
   ```sql
   update profiles set is_admin = true where email = 'tu-correo@ejemplo.com';
   ```
4. Vuelve a entrar en el sitio con esa cuenta: ahora verás el panel de
   administración (productos, categorías, clientes, pedidos e importar
   lista de precios en Excel).

## 4. Desplegar en Render

1. Sube esta carpeta a un repositorio de GitHub (ver sección siguiente).
2. En https://render.com, **New → Static Site**, conecta el repositorio.
3. Configuración:
   - **Build command:** (déjalo vacío, o `echo "no build"`)
   - **Publish directory:** `public`
4. Despliega. Render te da una URL (`https://tu-sitio.onrender.com`).
5. Si no commiteaste `public/config.js`, edítalo directo desde GitHub (o
   quítalo del `.gitignore` y haz commit) antes de desplegar, para que la
   tienda apunte a tu proyecto de Supabase.

También incluyo `render.yaml` por si prefieres usar un "Blueprint" de Render
para crear el servicio automáticamente.

## 5. Subir esto a un repositorio

Desde esta misma carpeta:
```bash
git init
git add .
git commit -m "Tienda MotoRepuestos: frontend + esquema Supabase"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/TU-REPO.git
git push -u origin main
```

## Estructura del proyecto

```
supabase/
  schema.sql   → tablas, seguridad (RLS) y bucket de imágenes
  seed.sql     → catálogo real (categorías + ~900 productos + ~390 fotos)
public/
  index.html   → estructura de la tienda
  styles.css   → estilos
  app.js       → toda la lógica (catálogo, cuentas, precios, carrito, admin)
  config.example.js → plantilla de credenciales (copiar como config.js)
render.yaml    → definición opcional para desplegar en Render
```

## Cómo funciona el precio por cliente

Cada cliente tiene un perfil con `tipo` (texto libre, ej. "Mayorista") y
`pct` (% de descuento sobre el precio base). Ambos son editables a mano por
el administrador desde **Panel de administración → Clientes** — no hay
topes automáticos por monto de compra, tal como se definió. Un visitante
sin cuenta siempre ve el precio base.

## Actualizar precios cada mes

Desde **Panel de administración → Productos → Importar lista de precios
(Excel)**, sube el archivo con las columnas `Producto, Código, Precio`
(mismo formato que la lista de octubre). El sistema:
- Actualiza el precio de los productos que coincidan por código.
- Crea como nuevos los códigos que no existan todavía.
- Si aparece una categoría nueva, la crea.

## Límites conocidos de este primer corte

- Cerca del 43% de los productos no trae foto todavía (el PDF del catálogo
  no cubre el 100% de los códigos de la lista de precios); se suben una por
  una desde "Editar producto".
- "Eliminar" a un cliente en el panel de administración borra su perfil de
  precios, no su cuenta de acceso (eso se hace desde el dashboard de
  Supabase, en Authentication → Users, si además quieres revocarle el
  acceso por completo).
- El carrito vive en el navegador de cada visitante (no se guarda en la
  base de datos hasta que confirma el pedido).
