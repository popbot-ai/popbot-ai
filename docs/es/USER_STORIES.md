# Historias de Usuario

La referencia de "cómo se ve el éxito" para PopBot. Capturada el 2026-05-01.
Cada decisión de implementación debería remontarse a una de estas.

El usuario es un solo desarrollador (Ben) ejecutando PopBot en su propia
máquina. El "yo" de abajo es él.

> **Estado (anotación añadida en 2026-07, al momento de la publicación).** Las
> historias de abajo son las historias de usuario *fundacionales* capturadas
> en 2026-05, preservadas aquí como el registro original de la intención de
> diseño. PopBot desde entonces se ha generalizado mucho más allá de ese
> alcance inicial de un solo usuario, Unity/Linear/Slack/GitHub — ahora
> abarca Git y Perforce, Unity y Unreal, Linear/Jira/GitHub Issues, PRs de
> GitHub y Helix Swarm, y se distribuye localizado en varios idiomas bajo
> una licencia MIT. Este documento intencionalmente *no* se ha retocado para
> coincidir; trátalo como historia, y consulta [GUIDE.md](GUIDE.md) para el
> conjunto de funcionalidades actual. Las historias US-1..US-9 y la captura
> de 2026-05 no han cambiado.

---

## US-1 · Conciencia de la cola de atención

> *"Debería estar al tanto de issues de alta prioridad, mensajes de Slack, y otros PRs que necesito atender."*

Tres fuentes mostradas juntas en la parte superior de la ventana:

- **Tickets de Linear** asignados a mí, clasificados por prioridad + fecha
  límite.
- **Mensajes de Slack** dirigidos a mí (DMs, @menciones, canales que
  administro). _Requisito nuevo; no estaba en el diseño original — consulta
  [Desviaciones](#desviaciones-y-adiciones)._
- **PRs de GitHub** solicitando mi revisión.

Cada fila muestra lo suficiente de un vistazo para clasificar sin hacer clic
(título, fuente, antigüedad, indicador de prioridad). Los elementos de alta
prioridad destacan visualmente frente a los de baja prioridad.

**Corresponde a:** [POPBOT_DESIGN.md → Disposición de la app](POPBOT_DESIGN.md#disposición-de-la-app) (paneles de Tickets / Revisiones — extender con un panel de Slack).

---

## US-2 · Activación de un clic

> *"Debería poder iniciar actividad en cualquiera de estos fácilmente, y abrir un chat para empezar a trabajar."*

Hacer clic en cualquier fila de la cola de atención genera un chat nuevo
sembrado para ese trabajo:

- Ticket de Linear → chat sembrado con el cuerpo del ticket, rama nombrada
  según la clave del ticket, prompt del agente prellenado.
- Mensaje de Slack → chat sembrado con el contexto de la conversación, listo
  para redactar una respuesta o iniciar trabajo real.
- PR → chat sembrado con el diff y la lista de verificación de revisión.

Sin fricción de configuración entre "veo algo que necesito atender" y "un
agente está trabajando en ello."

**Corresponde a:** [POPBOT_DESIGN.md → Disposición de la app](POPBOT_DESIGN.md#disposición-de-la-app) ("Haz clic en una fila → genera un chat sembrado para ese trabajo").

---

## US-3 · Pruebas reales del videojuego en el chat

> *"Los chats deberían poder activar una instancia de Unity y ejecutar unity/server cuando sea necesario para poder probar y depurar el trabajo."*

Cuando un chat necesita verificar comportamiento en el videojuego real, el
chat adquiere un slot, genera Unity (colocado en la pantalla 2), y
opcionalmente genera el servidor sidecar. El agente maneja el videojuego vía
el MCP dentro del Editor — entrando en modo Play, haciendo clic en la
interfaz, tomando capturas de pantalla, leyendo logs, verificando el estado.

Adquirir un slot es la parte lenta la primera vez (~15-30 s en frío); la
actividad subsiguiente es pegajosa (~50 ms).

**Corresponde a:** [POPBOT_DESIGN.md → Tipos de chat](POPBOT_DESIGN.md#tipos-de-chat) (Client Test / Server Test), [Slots](POPBOT_DESIGN.md#slots--la-unidad-duradera), [Superficie de automatización MCP](POPBOT_DESIGN.md#superficie-de-automatización-mcp).

---

## US-4 · Finalización autónoma de extremo a extremo con prueba

> *"Los agentes deberían poder trabajar de forma completamente autónoma, y arreglar/depurar y completar un ticket entero, incluyendo entregar prueba de que el arreglo/cambio funcionó según lo requerido en un documento markdown que se pueda inspeccionar."*

En modo autónomo el agente ejecuta un ciclo completo de leer → reproducir →
arreglar → verificar sin intervención, y escribe un artefacto `proof.md` al
final. La prueba contiene:

- **Reproducción (Repro)** — los pasos exactos que demostraron el bug.
- **Antes** — capturas de pantalla + volcados de logs filtrados del estado
  roto.
- **Causa raíz** — el diagnóstico del agente.
- **Arreglo** — el diff o resumen de los cambios.
- **Después** — capturas de pantalla + volcados de logs limpios del estado
  arreglado.
- **Verificación** — una nueva ejecución de la reproducción, ahora exitosa.

Puedo abrir `proof.md` y decidir si el trabajo está bien sin volver a
ejecutar nada yo mismo. La pausa para revisión solo es necesaria para
operaciones arriesgadas (`git push`, `gh pr create`, etc.).

**Corresponde a:** [POPBOT_DESIGN.md → Modo autónomo](POPBOT_DESIGN.md#modo-autónomo), [Artefactos de prueba](POPBOT_DESIGN.md#artefactos-de-prueba-entregable-de-depuración-del-agente).

---

## US-5 · Multitarea fácil vía miniaturas

> *"Debería poder alternar fácilmente entre agentes, haciendo clic en las miniaturas."*

La franja de miniaturas es la superficie de navegación principal para el
trabajo en paralelo. Una fila de vistas previas compactas — una por chat —
me permite saltar entre agentes al instante. Hacer clic en una miniatura
trae ese chat al frente; los demás chats siguen corriendo en segundo plano.

La miniatura en sí comunica estado, no solo identidad. Consulta US-6.

**Corresponde a:** [POPBOT_DESIGN.md → Disposición de la app](POPBOT_DESIGN.md#disposición-de-la-app) (fila de miniaturas), Fase 3 en [PHASING.md](PHASING.md).

---

## US-6 · Estado de un vistazo

> *"Debería poder hacerme fácilmente una idea de qué está haciendo un agente, y si necesitan asistencia o dirección de mi parte, de un vistazo."*

Cada miniatura de chat muestra su estado actual sin que tenga que hacer clic
para entrar:

| Color | Significado |
|---|---|
| Azul | En ejecución |
| Verde | Tarea completa |
| **Amarillo** | **Pausado — me necesita** |
| Rojo | Con error |
| Gris | Inactivo / no iniciado |

El amarillo es el que exige atención. Escanear la fila de miniaturas debería
responder "¿alguien está atascado?" en menos de un segundo. Más allá del
color, la miniatura muestra una pista de progreso breve (última acción, paso
actual) para que pueda decidir si entrar a fondo.

**Corresponde a:** [POPBOT_DESIGN.md → Colores de estado](POPBOT_DESIGN.md#colores-de-estado-miniatura-de-chat).

---

---

## US-7 · Recuperar y continuar desde cualquier lugar

> *"Debería poder recuperar y continuar fácilmente con tickets, incluso los que ya no están activos, desde donde los dejé."*

Un chat es duradero. Incluso después de cerrarlo, reiniciar PopBot, o
reiniciar la máquina, puedo reabrir cualquier chat pasado y retomarlo
exactamente donde lo dejé:

- La transcripción completa se reproduce en la columna de chat.
- El slot se vuelve a adquirir (o se levanta en frío) en la misma rama en
  la que estaba.
- El estado de Unity + sidecar se restaura al fixture / blob de guardado
  relevante si se había establecido uno.
- El agente vuelve a leer la transcripción reciente antes de responder a mi
  siguiente mensaje — el contexto no se pierde a través del reinicio.

Cerrar un chat libera su slot; reabrirlo lo vuelve a adquirir. El chat es el
registro duradero; el slot es infraestructura transitoria.

**Corresponde a:** [POPBOT_DESIGN.md → Slots](POPBOT_DESIGN.md#slots--la-unidad-duradera) (ciclo de vida de slot vs. chat), [Stack tecnológico → better-sqlite3](POPBOT_DESIGN.md#stack-tecnológico) (persistencia de transcripción). El esquema del registro por chat vive en `src/main/persistence/`.

---

## US-8 · Inspección por ticket: chat + Unity + logs + prueba

> *"Debería poder revisar fácilmente el progreso de un ticket mostrando el contenido, la instancia de servidor/Unity en ejecución, los logs relevantes, el artefacto de finalización (markdown)."*

Para cualquier chat (activo o pausado), un clic muestra todo lo que necesito
para evaluar el progreso:

- **Contenido del chat** — la transcripción en ejecución con el razonamiento
  del agente, las llamadas a herramientas, y las salidas.
- **Estado de servidor / Unity** — ¿está el slot activo?, ¿qué rama?, ¿cuál
  es la pila de pantallas?, ¿está Unity en modo Play?
- **Logs relevantes** — consola de Unity + servidor sidecar, filtrados a la
  sesión del chat, con desplazamiento sincronizado.
- **Artefacto de finalización** — el `proof.md` (y los `before/`, `after/`,
  `diff.patch` de apoyo) que produjo el agente, renderizado en línea.

Esta es la vista de "muéstrame qué pasó." No la manguera de datos crudos —
el corte transversal curado que responde "¿está bien hecho esto?"

**Corresponde a:** [POPBOT_DESIGN.md → Disposición de la app](POPBOT_DESIGN.md#disposición-de-la-app) (columna de chat + panel de logs inferior), [Artefactos de prueba](POPBOT_DESIGN.md#artefactos-de-prueba-entregable-de-depuración-del-agente). El renderizador de pruebas vive en `src/renderer/chat/ProofViewer.tsx` (planeado).

---

## US-9 · Concesiones de permiso justo a tiempo

> *"Debería poder darle fácilmente permiso a los agentes para hacer varias cosas que no deberían poder hacer de forma completamente autónoma."*

Cuando un agente quiere hacer algo en la lista de siempre-pausar (`git push`,
`gh pr create`, `rm` fuera del slot, llamadas de red a hosts no autorizados,
etc.), PopBot se pausa y me pregunta. El flujo de concesión es:

- Aparece un modal con **qué** quiere hacer el agente, **por qué** (la razón
  declarada del agente), y el **comando / argumentos**.
- Puedo **permitir una vez**, **permitir para este chat / sesión**,
  **permitir siempre** (regla duradera por herramienta, por objetivo), o
  **denegar**.
- Las reglas de permiso se acumulan por chat, mostradas en el panel de
  configuración del chat para que pueda revocarlas.
- La lista de denegación fija en el código nunca es anulable desde la
  interfaz — consulta [adr/0004](../adr/0004-canusetool-policy-boundary.md).

El punto: la autonomía es lo por defecto, pero puedo aprobar sin fricción
una acción arriesgada específica sin abrir una terminal ni vigilar al
agente.

**Corresponde a:** [POPBOT_DESIGN.md → Modo autónomo](POPBOT_DESIGN.md#modo-autónomo), [adr/0004 — límite de política canUseTool](../adr/0004-canusetool-policy-boundary.md). El almacén de concesiones vive en `src/main/agents/policy/`.

---

## Desviaciones y adiciones

Esta sección marca los lugares donde las historias de usuario divergen del
diseño ya fijado. Al implementar, usa las historias de usuario como la
fuente de verdad y actualiza el documento de diseño.

### Slack como una tercera fuente de atención (US-1)

El diseño original cubre los tickets de Linear y los PRs sin revisar. Los
mensajes de Slack no estaban en el alcance. Para honrar US-1:

- Añadir un **panel de Slack** al grupo de pestañas superior-izquierdo junto
  a Tickets y Revisiones.
- Fuente: DMs de Slack, @menciones, y mensajes en canales que administro.
  Reglas de filtrado por determinar según el flujo de trabajo de generación
  de chat.
- Autenticación: OAuth de Slack (token en el llavero vía `keytar`).
- Generar un chat desde un mensaje de Slack siembra al agente con el
  contexto de la conversación.

Este es un **subsistema completamente nuevo** — cliente de API de Slack en
`src/main/slack/`, panel en `src/renderer/panels/slack/`. Fasearlo en la
Fase 3 de [PHASING.md](PHASING.md) junto a los otros paneles, pero tratarlo
como un par de primera clase, no como una idea de último momento.
