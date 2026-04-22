# BlueSales

Plataforma interna para ventas y comunicados, estandarizada con una estructura moderna por capas (configuracion, modulos de dominio y API).

## Stack

- Runtime: Node.js (ESM)
- Backend: Express
- Persistencia: Firebase Firestore
- Frontend: HTML + CSS + JavaScript vanilla

## Estructura del proyecto

```text
public/
  assets/images/          # recursos estaticos (imagenes)
  css/main.css            # estilos
  js/main.js              # logica frontend
  index.html              # vista principal

scripts/
  clean-proxy.cjs         # utilidad de limpieza de proxy

src/
  main.js                 # punto de arranque del servidor
  app.js                  # configuracion de Express y middlewares
  config/
    env.js                # carga y normalizacion de variables de entorno
    firebase.js           # inicializacion de Firebase/Firestore
  api/
    routes/
      api-router.js       # endpoints REST
  modules/
    auth/
      token.service.js    # creacion/validacion de token
    identity/
      dni-validation.service.js
    state/
      default-state.factory.js
      state.repository.js
```

## Modelo de datos Firestore

La persistencia ahora esta normalizada por colecciones:

- `settings/global`
- `users/{dni}`
- `orders/{orderId}`
- `notices/{noticeId}`
- `notifications/{notificationId}`
- `order_history/{eventId}`
- `users/{dni}/notice_reads/{noticeId}`
- `admin_users/{username}`

Compatibilidad y migracion:

- Si existe el documento legado `app/state`, se migra automaticamente a las colecciones al iniciar.
- Si Firebase no esta configurado en desarrollo/no-produccion, se usa fallback en memoria.
- En produccion, el arranque se bloquea si Firebase/Firestore no esta correctamente configurado.

## Configuracion

1. Instala dependencias:

```bash
npm install
```

2. Crea `.env` usando `.env.example` y completa credenciales:

```env
PORT=3000
APP_TOKEN_SECRET=x7Y!n2Qv4Lk91MpaT3r8Wd6$Hs0Cz5Jk
APP_TOKEN_TTL_MS=43200000
PASSWORD_HASH_ROUNDS=12
AUTH_LOGIN_RATE_LIMIT_WINDOW_MS=600000
AUTH_LOGIN_RATE_LIMIT_MAX=6
AUTH_REGISTER_RATE_LIMIT_WINDOW_MS=1800000
AUTH_REGISTER_RATE_LIMIT_MAX=5
ADMIN_USER=admin
ADMIN_PIN=936274
SUPER_ADMIN_USER=ccruces
SUPER_ADMIN_PASSWORD=ChangeMe!2026
SUPER_ADMIN_NAME=Super Administrador
HTTP_BODY_LIMIT=256kb
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
CORS_ALLOW_NO_ORIGIN=false
ALLOW_PROD_MIGRATION=false
ALLOW_PROD_SEED=false
ALLOW_PROD_AUDIT=false
ALLOW_PROD_PROXY_CLEAN=false

FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=
FIREBASE_MEASUREMENT_ID=

SUNAT_DNI_VALIDATION_ENABLED=false
SUNAT_DNI_API_URL_TEMPLATE=
SUNAT_DNI_API_TOKEN=
SUNAT_DNI_API_AUTH_SCHEME=Bearer
SUNAT_DNI_API_KEY=
SUNAT_DNI_API_KEY_HEADER=x-api-key
SUNAT_DNI_TIMEOUT_MS=8000
SUNAT_DNI_STRICT_NAME_MATCH=true
```

## Scripts

- `npm run dev`: inicia en modo watch
- `npm start`: inicia en modo normal
- `npm run check`: validacion sintactica rapida de archivos clave
- `npm run preflight:prod`: valida requisitos minimos para despliegue productivo (`NODE_ENV=production`)
- `npm run audit:deps`: ejecuta auditoria de dependencias (`npm audit` en severidad alta)
- `npm run clean:proxy`: limpia configuraciones de proxy local
- `npm run audit:passwords`: audita usuarios con password legacy o hash invalido
- `npm run migrate:force`: migra `app/state` legado a colecciones (bloqueado en prod salvo `ALLOW_PROD_MIGRATION=true`)

Notas de seguridad para scripts sensibles:

- `seed-bulk-data.mjs` bloqueado en prod salvo `ALLOW_PROD_SEED=true`.
- `audit-password-hashes.mjs` bloqueado en prod salvo `ALLOW_PROD_AUDIT=true`.
- `clean-proxy.cjs` bloqueado en prod salvo `ALLOW_PROD_PROXY_CLEAN=true`.

## API base

- `GET /api/health`
- `GET /api/identity/dni/:dni`
- `POST /api/auth/login`
- `POST /api/auth/register`
- `GET /api/auth/me`
- `POST /api/auth/logout` (revoca la sesion actual)
- `POST /api/auth/revoke` (solo admin, revoca por `sessionId` o por principal)
- `GET /api/admin/users` (solo super admin)
- `POST /api/admin/users` (solo super admin, crea admins)
- `GET /api/state` (requiere token `Bearer`; worker recibe solo su propio alcance) **[TRANSICION/DEPRECATED]**
- `PUT /api/state` (solo admin) **[TRANSICION/DEPRECATED]**
- `POST /api/worker/orders` (solo worker)
- `POST /api/worker/orders/:orderId/confirm` (solo worker)
- `POST /api/worker/orders/:orderId/cancel` (solo worker)

Legacy (solo admin autenticado):

- `GET /users`
- `POST /users`
- `GET /orders`

## Politica RBAC (Fase 2)

- `super_admin`: acceso total, puede crear admins y gestionar sesiones de cualquier rol.
- `admin`: puede gestionar estado global (`PUT /api/state`), exportes, revocacion de sesiones y rutas legacy admin; no puede ver ni gestionar datos de credenciales de super admin.
- `worker`: solo puede consultar su alcance de datos en `GET /api/state` y operar sus propios pedidos mediante endpoints `/api/worker/orders/*`.
- `worker` no puede modificar estado global. `PUT /api/state` devuelve `403`.

## Transicion de `/api/state`

- `/api/state` se mantiene temporalmente por compatibilidad.
- El endpoint responde con headers de transicion/deprecacion: `Deprecation`, `Sunset`, `Warning`, `X-API-Transition`.
- Fecha objetivo de retiro (header `Sunset`): `Wed, 31 Dec 2026 23:59:59 GMT`.
- Objetivo: reemplazar gradualmente por endpoints especificos por recurso (`/api/worker/orders/*`, auth/session y futuros endpoints de settings/orders/notices/users).

## Politica de sesion (Fase 2)

- Tokens incluyen `sid` (session id), `iat` y `exp`.
- `POST /api/auth/logout` revoca la sesion actual.
- `POST /api/auth/revoke` permite a admin revocar por `sessionId` o por principal (`role + id`).
- Solo `super_admin` puede revocar por principal cuando el objetivo es `super_admin`.
- Revocaciones se verifican en cada request autenticado y se persisten en Firestore cuando esta configurado:
  - `security_revoked_sessions/{sid}`
  - `security_revoked_principals/{role__id}`
- Si Firestore no esta disponible, se mantiene fallback en memoria.
- En produccion se desactiva la cache negativa de revocacion para evitar ventanas de consistencia diferida.

## Paso A Productivo (runbook)

1. Configurar secretos y entorno:

```bash
# ejemplo (PowerShell)
$env:NODE_ENV="production"
```

`APP_TOKEN_SECRET`, `ADMIN_PIN`, `SUPER_ADMIN_USER`, `SUPER_ADMIN_PASSWORD`, `FIREBASE_*` y `CORS_ALLOWED_ORIGINS` deben estar definidos con valores de produccion.

2. Ejecutar validaciones previas:

```bash
npm run check
npm run audit:deps
npm run preflight:prod
```

3. Migracion de estado legado (solo si aun existe `app/state`):

```bash
# habilitar solo para la ejecucion puntual
ALLOW_PROD_MIGRATION=true npm run migrate:force
```

4. Verificacion posterior al despliegue:

- `GET /api/health` debe responder `ok: true` y `storage: "firestore"`.
- Probar login super admin/admin/worker, `GET /api/auth/me`, y un endpoint worker (`POST /api/worker/orders`).
- Confirmar headers de transicion en `/api/state`: `Deprecation`, `Sunset`, `Warning`.

5. Cierre operativo:

- Remover flags `ALLOW_PROD_*` tras usar scripts puntuales.
- Rotar secretos si se compartieron en canales inseguros.
