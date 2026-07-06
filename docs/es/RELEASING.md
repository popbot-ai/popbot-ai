# Publicar PopBot

Los lanzamientos se compilan con GitHub Actions en **macOS, Windows y
Linux**, y se publican en un GitHub Release de este repositorio. Cada
plataforma se compila en su propio runner — los módulos nativos
(`better-sqlite3`, `node-pty`) deben compilarse contra el ABI de Electron
por SO, así que la compilación cruzada no es una opción.

## Cortar un lanzamiento

Desde un árbol de trabajo limpio en `main`:

```bash
npm run release            # patch bump (default)
npm run release -- minor   # minor bump
npm run release -- major   # major bump
```

`scripts/release.sh` incrementa la versión, hace commit, crea un tag
anotado `vX.Y.Z`, y sube ambos. El tag subido dispara el flujo de trabajo de
**Build**, que compila las tres plataformas y publica el GitHub Release con
los artefactos adjuntos. Obsérvalo con `gh run watch` o la pestaña Actions.

La siguiente versión se calcula a partir del último tag `v*`, incrementado
según el argumento de arriba. Antes de que exista cualquier tag, recae en
la versión de `package.json` (así que el primer lanzamiento es el siguiente
incremento por encima de esa). El script se niega a ejecutarse desde
cualquier rama que no sea `main` (anular con `RELEASE_BRANCH=<name>`).

## Qué se produce

| Plataforma | Artefactos |
|----------|-----------|
| macOS    | `.dmg`, `.zip`, `latest-mac.yml`, `.blockmap` |
| Windows  | Instalador NSIS `.exe`, `.zip`, `latest.yml`, `.blockmap` |
| Linux    | `.deb` (sin auto-actualización — consulta la nota de Linux abajo) |

Los archivos `latest*.yml` + `.blockmap` son metadatos de electron-updater
(la configuración `publish: github` de
[`electron-builder.yml`](../../electron-builder.yml) los genera). El
auto-actualizador dentro de la aplicación los consume para detectar,
descargar, y preparar actualizaciones — consulta la sección de
Auto-actualización abajo.

Flujo de trabajo: [`.github/workflows/build.yml`](../../.github/workflows/build.yml).

## Disparadores de CI

- **Push de tag `v*`** → compila todas las plataformas (firmado si los
  secretos están configurados) + publica un GitHub Release.
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
En las compilaciones empaquetadas, consulta los releases de este
repositorio, **descarga silenciosamente** una versión más nueva en segundo
plano, y muestra una notificación de **"Restart to install"** cuando está
lista — hacer clic en ella cierra y relanza en la nueva versión. Lee los
metadatos `latest*.yml` + `.blockmap` que adjunta el flujo de trabajo de
release; la configuración `publish: github` en `electron-builder.yml`
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
2. **Corta el release N**, por ejemplo `npm run release` → `v0.0.18`.
   Espera a que el flujo de trabajo publique el Release con los assets +
   `latest*.yml`.
3. **Instala N desde el Release publicado** en cada SO que soportes (`.dmg`
   de macOS, `.exe` de Windows, `.deb` de Linux). Lánzalo — verifica que
   Help ▸ About muestre la versión correcta.
4. **Corta el release N+1**, por ejemplo `npm run release` → `v0.0.19`.
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
