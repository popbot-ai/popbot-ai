# Publicar PopBot

Los lanzamientos se compilan con GitHub Actions en **macOS, Windows y
Linux**, y se publican en **Cloudflare R2** (`download.popbot.app`) — *no*
en GitHub Releases. Cada plataforma se compila en su propio runner — los módulos nativos
(`better-sqlite3`, `node-pty`) deben compilarse contra el ABI de Electron
por SO, así que la compilación cruzada no es una opción.

## Antes de cortar: actualiza las notas de la versión

Tres sitios contienen el texto de «novedades» que ve el usuario, y los tres
se **escriben a mano**: nada los genera. Actualízalos en el mismo PR que la
funcionalidad, para que una versión nunca salga describiendo la anterior:

1. **Ventana What's New en la app** — `whatsNew.f1.*` / `whatsNew.f2.*` en
   `src/shared/i18n/messages/*.ts`. **Los 12 idiomas.** Se muestra una vez
   por versión al abrir la app tras actualizar.
2. **Banda del hero en la web** — las dos líneas `whatsnew.f*` de
   `site/index.html` **y** sus traducciones en `site/i18n.js`.
   **Los 12 idiomas.**
3. **Tabla `## Recent releases` al inicio de `README.md`** — añade la nueva
   versión y quita la más antigua, manteniendo tres. **Solo el README en
   inglés**: las copias traducidas en `docs/<locale>/README.md` no llevan
   esta tabla a propósito, para que no quede desactualizada en otros 11
   idiomas.

Limita 1 y 2 a una o dos funcionalidades principales. Menciona cualquier
cambio que afecte a chats existentes (por ejemplo, un modelo retirado que se
migra solo): los usuarios lo notan, lo cuentes o no.

Las betas van aparte: los puntos de la banda beta salen de
`beta-highlights.json`, que `scripts/gen-manifest.mjs` incorpora al
manifiesto de descargas.

## Cortar un lanzamiento

Los lanzamientos se ejecutan **enteramente desde GitHub Actions**: no hay
paso local (`npm run release` es solo un stub que redirige aquí).

GitHub → **Actions** → **Release** → **Run workflow**:

- **bump**: `patch` | `minor` | `major`
- **channel**: `prerelease` (build de prueba en `beta/`; firmado solo si los secrets de
  firma están configurados — se permite un prerelease sin firmar) | `release` (publicar en
  `stable/` como «latest»; macOS **debe** ir firmado + notarizado o el job falla)

La siguiente versión se calcula a partir del último tag `v*` final (se ignoran
los tags que contienen `-`), incrementado según **bump**. Un `prerelease`
recibe además el sufijo `-rc.<run_number>` y va a `beta/`; un `release` va a
`stable/`.

**Los tags de Git son la fuente de verdad para la versión.** El flujo de trabajo
basa la siguiente versión en el último tag final; solo recurre a `package.json`
cuando aún no existe ningún tag `v*` final (es decir, en el primer lanzamiento).
Nunca hace commit de una versión: aplica la calculada en tiempo de compilación
con `npm version --no-git-tag-version`. Aun así, mantén actualizada la versión de
`package.json` (increméntala en el PR del lanzamiento) para que el repo y las
builds locales no muestren un número obsoleto.

## Qué se produce

| Plataforma | Artefactos |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | Instalador NSIS `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb` (sin auto-actualización — consulta la nota de Linux abajo) |

Los archivos `latest*.yml` + `.blockmap` son metadatos de electron-updater
(la configuración `publish: generic` de
[`electron-builder.yml`](../../electron-builder.yml) los genera). El
auto-actualizador dentro de la aplicación los consume para detectar,
descargar, y preparar actualizaciones — consulta la sección de
Auto-actualización abajo.

Flujo de trabajo: [`.github/workflows/release.yml`](../../.github/workflows/release.yml).

## Disparadores de CI

- **Push de tag `v*`** → compila todas las plataformas (firmado si los
  secretos están configurados) + sube a `…/<channel>/<version>/` y promueve el feed del canal.
- **Pull request a `main`** (no-docs) → solo compilación de validación,
  **siempre sin firmar**; los artefactos se adjuntan a la ejecución, nada
  se publica, no se usan secretos.
- **Manual** → "Run workflow" (workflow_dispatch), sin firmar.

La firma solo se ejecuta en un push de tag `v*`, que solo el dueño del
repositorio puede hacer. GitHub nunca expone secretos a las ejecuciones de
PR disparadas por forks, así que los PRs de colaboradores no pueden
alcanzar los certificados de firma.

## Firma de código

La firma está impulsada por **secretos de GitHub Actions** (Settings →
Secrets and variables → Actions). Están cifrados, nunca en el árbol de
git, y enmascarados en los logs. Sin ninguno configurado, las
compilaciones de tag producen binarios sin firmar (Gatekeeper de macOS /
SmartScreen de Windows advierten en el primer lanzamiento) y CI aun así
pasa.

### macOS (firmar + notarizar)

| Secreto | Valor |
|--------|-------|
| `MAC_CSC_LINK` | base64 de tu `.p12` de "Developer ID Application" (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | contraseña de ese `.p12` |
| `APPLE_ID` | correo de Apple ID usado para la notarización |
| `APPLE_APP_SPECIFIC_PASSWORD` | contraseña específica de app desde appleid.apple.com |
| `APPLE_TEAM_ID` | ID de equipo de Apple Developer |

Una compilación de tag firma + notariza solo cuando está presente el
**conjunto completo** — `MAC_CSC_LINK`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, **y** `APPLE_TEAM_ID` (más
`MAC_CSC_KEY_PASSWORD` para el certificado). Si falta alguno, compila sin
firmar en lugar de fallar la notarización tarde, así que un conjunto de
secretos a medio configurar no rompe CI.

### Windows (opcional)

| Secreto | Valor |
|--------|-------|
| `WIN_CSC_LINK` | base64 de tu `.pfx` de firma de código |
| `WIN_CSC_KEY_PASSWORD` | contraseña de ese `.pfx` |

Una compilación de tag firma cuando `WIN_CSC_LINK` está presente; de lo
contrario sin firmar.

## Auto-actualización

La auto-actualización dentro de la aplicación está conectada con
**electron-updater**
([`src/main/updates/autoUpdate.ts`](../../src/main/updates/autoUpdate.ts)).
En las compilaciones empaquetadas, consulta el feed R2 del canal
(`download.popbot.app/<channel>/`) de este
repositorio, **descarga silenciosamente** una versión más nueva en segundo
plano, y muestra una notificación de **"Restart to install"** cuando está
lista — hacer clic en ella cierra y relanza en la nueva versión. Lee los
metadatos `latest*.yml` + `.blockmap` que adjunta el flujo de trabajo de
release; la configuración `publish: generic` en `electron-builder.yml`
incrusta el `app-update.yml` que el cliente necesita.

**La firma es obligatoria para el paso de instalación.** macOS rechaza las
actualizaciones sin firmar, así que la instalación dentro de la aplicación
solo funciona una vez que los releases están firmados + notarizados (la
ruta de compilación de tag con los secretos de Apple configurados). Hasta
entonces — y siempre que el actualizador encuentre un error (sin metadatos,
fallo de red) — **recae** en una notificación manual de "Download" que
abre la página del release, impulsada por la verificación ligera de GitHub
en [`src/main/updates/check.ts`](../../src/main/updates/check.ts). Esa
misma verificación ligera también respalda el "Check for updates" bajo
demanda del diálogo Acerca de, y funciona en todas partes, incluyendo
desarrollo y compilaciones sin firmar.

Para que cualquiera de esto muestre un release, el flujo de trabajo debe
publicar Releases **no-borrador, no-prerelease** con los instaladores de
plataforma adjuntos — lo cual hace. La auto-actualización está
deshabilitada en desarrollo.

### Verificar la auto-actualización (primera prueba de extremo a extremo)

La ruta de auto-actualización solo se puede verificar contra **dos
releases reales firmados** — no en desarrollo (está deshabilitada) y no
contra un solo release (no hay nada más nuevo que descargar). Hazlo una
vez, después de que la firma esté configurada:

1. **Confirma que la firma está activada.** Añade los secretos de macOS (y
   opcionalmente Windows) de la tabla de arriba. El primer release firmado
   debe tener éxito — en macOS, las compilaciones sin firmar/sin notarizar
   pueden descargarse pero **fallan al instalar**, así que toda esta
   prueba no tiene sentido sin firmar.
2. **Corta el release N** — Actions → Release → bump `patch`, channel
   `release` (p. ej. → `v0.1.2`). Espera a que el flujo de trabajo publique
   que `download.popbot.app/stable/<version>/` contenga los instaladores y que
   la raíz del canal `download.popbot.app/stable/` tenga el `latest*.yml` promovido.
3. **Instala N desde el Release publicado** en cada SO que soportes (`.dmg`
   de macOS, `.exe` de Windows, `.deb` de Linux). Lánzalo — verifica que
   Help ▸ About muestre la versión correcta.
4. **Corta el release N+1** de la misma forma (p. ej. → `v0.1.3`).
5. **Deja la instalación de N corriendo.** Dentro de ~30s de lanzamiento (y
   luego cada 6h) verifica; en una compilación firmada descarga N+1
   silenciosamente, luego muestra la notificación de **"Restart to
   install."** Haz clic en ella.
6. **Confirma que se relanzó en N+1** — Help ▸ About ahora muestra la
   nueva versión. Eso prueba que descargar → preparar → quitAndInstall →
   relanzar funciona en ese SO.

Notas por plataforma:
- **macOS:** Squirrel.Mac aplica la actualización desde el asset `.zip`
  (no el `.dmg`); ambos deben estar en el Release. Gatekeeper rechaza una
  actualización sin firmar/sin notarizar — si "Restart to install" no hace
  nada, vuelve a verificar la notarización en la compilación.
- **Linux:** el `.deb` **no** se auto-actualiza — electron-updater solo
  auto-actualiza AppImage en Linux. Actualiza instalando el nuevo `.deb`
  (`sudo dpkg -i …` / `sudo apt install ./…`). Así que omite los pasos de
  auto-actualización (4–6) para Linux; simplemente instala N+1 sobre N y
  confirma en About. Para restaurar la auto-actualización dentro de la
  aplicación en Linux, vuelve a añadir `AppImage` a `linux.target` en
  `electron-builder.yml`.
- **Windows:** la instalación NSIS actualiza en el lugar; SmartScreen
  puede advertir hasta que la compilación esté firmada con
  `WIN_CSC_LINK`.

Si el paso 5 en su lugar muestra una notificación de **"Download"**
(abriendo la página del release), el actualizador dentro de la aplicación
encontró un error y recayó — revisa el log de diagnóstico (entradas
`update.error` / `update.check.failed`) para saber por qué, lo más común es
una compilación de macOS sin firmar.
