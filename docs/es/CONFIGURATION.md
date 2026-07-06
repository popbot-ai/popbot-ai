# Configurar PopBot

Todo en PopBot se configura dentro de la aplicación a través de **Preferencias** (el engranaje en la barra de título, o `⌘,`) — no hay archivos de configuración para editar a mano. Esta guía recorre cada panel en el orden en que los lista la navegación, que es aproximadamente el orden en que los configurarías la primera vez.

> Las credenciales que ingreses (Linear, Jira, GitHub, Perforce, etc.) se almacenan **localmente en tu máquina** en la propia base de datos de la aplicación — nunca en este repositorio.

- [Integraciones](#integraciones) · [Agentes](#agentes) · [Runtime y slots](#runtime-y-slots) · [Repositorios](#repositorios) · [Control de código fuente](#control-de-código-fuente) · [Aplicaciones externas](#aplicaciones-externas) · [Plantillas de prompts](#plantillas-de-prompts) · [Revisiones de código](#revisiones-de-código) · [Notificaciones](#notificaciones) · [Permisos](#permisos) · [Idioma](#idioma)

---

## Integraciones

Aquí viven dos grupos independientes: la **fuente de tickets** que alimenta la cola de Tickets, y los **motores de videojuegos** que un slot puede lanzar.

![Integrations — Linear](../../images/preferences_integrations1.png)

### Fuente de tickets

Un único rastreador de issues activo alimenta la cola de Tickets. Elígelo desde el selector en la parte superior del panel; el formulario de configuración de abajo cambia para coincidir. Solo un rastreador está activo a la vez.

- **Linear** — pega una clave de API (desde *linear.app → Settings → API*). Opcionalmente establece una **Clave de equipo** (por ejemplo, `ENG`) para delimitar el feed de tickets a un equipo, y elige un **Proyecto** para acotarlo más. Guardar verifica la clave y muestra con quién se conectó.
- **Jira** — ingresa la URL de tu sitio (`https://your-domain.atlassian.net`), el correo de la cuenta, y un token de API (desde *id.atlassian.com → Security → API tokens*). Opcionalmente delimita a un **Proyecto** y añade un filtro **JQL** (por ejemplo, `labels = backend`). Guardar verifica las credenciales antes de persistirlas.
- **GitHub** — GitHub Issues no necesita credenciales aquí: el proveedor invoca el CLI `gh` que ya autenticaste para revisiones y acciones de git, y la cola abarca los mismos repositorios configurados en [Repositorios](#repositorios). El formulario es una verificación de estado que confirma que `gh` está instalado y autenticado y reporta cuántos repositorios cubre.

Cada rastreador con credenciales las verifica al **Guardar** antes de persistirlas, y muestra una píldora de estado de *Conectado / No conectado*.

### Motores de videojuegos

A diferencia de la fuente de tickets de selección única, los motores son **independientes** — puedes habilitar Unity, Unreal, y un motor Personalizado a la vez. Cada motor habilitado añade un botón **Ejecutar** a la barra de chat que lanza su editor desde el espacio de trabajo del slot del chat.

- **Habilitado** — una casilla por motor que muestra (u oculta) el botón Ejecutar de ese motor en la barra de chat.
- **Instalaciones detectadas / Binario del editor** *(Unity, Unreal)* — PopBot escanea en busca de editores instalados (instalaciones de Unity Hub / Epic), con un enlace de **reescaneo**; elige una versión detectada, o ingresa una ruta absoluta de **Binario del editor** para anular el menú desplegable.
- **Comando de ejecución** *(Personalizado)* — un comando de shell libre ejecutado en el directorio del proyecto, con variantes separadas para **macOS / Linux** y **Windows** para que una sola configuración funcione multiplataforma. Un motor personalizado no tiene autodetección; PopBot pasa la identidad del slot a tu comando vía una variable de entorno `POPBOT_SLOT` para que puedas conectar tu propio flujo de "ejecutar y verificar."
- **Subruta del proyecto** — la ruta del proyecto del motor relativa a la raíz del espacio de trabajo (la carpeta del proyecto de Unity; la carpeta que contiene el `.uproject`; o el directorio de trabajo en el que se ejecuta un comando personalizado). Déjalo en blanco si la raíz del espacio de trabajo *es* el proyecto.
- **Usar MCP + Puerto base de MCP** *(Unity, Unreal)* — cuando la casilla **Usar MCP** está activada, el editor se lanza apuntando a un servidor MCP dentro del editor para que un agente pueda manejarlo. Cada slot obtiene su **propio puerto** para que los slots en paralelo nunca colisionen: el puerto es `basePort + (slotId − 1)` (slot 1 → base, slot 2 → base + 1, …). El campo **Puerto base de MCP** establece el puerto del slot 1; por defecto es **8000 para Unreal** y **8080 para Unity** (coincidiendo con el valor por defecto del plugin MCP de cada motor) y se restaura a ese valor por defecto al vaciarse.
- **Mostrar ruta del proyecto en la barra de título** *(Unity)* — un botón de **Instalar script de barra de título** que coloca un pequeño script de editor en tu proyecto de Unity para que cada Editor abierto muestre la ruta completa de su proyecto en su barra de título, facilitando distinguir las ventanas de los slots. El script es seguro de confirmar (commit).

> **Slack** y **Sentry** siguen siendo conexiones esbozadas en lugar de fuentes de bandeja de entrada conectadas, así que no se muestran como paneles aquí por ahora. Pueden reactivarse sin cambios estructurales; consulta la nota al final de la [Guía de Funcionalidades y Flujos de Trabajo](GUIDE.md).

## Agentes

**Esfuerzo de razonamiento** del modelo por defecto para los chats recién creados (los chats existentes conservan el suyo propio hasta que lo cambies en el compositor de chat).

![Agents](../../images/preferences_agents.png)

- Establece el esfuerzo de forma independiente para **Claude** y **Codex**, y por separado para:
  - **Chats nuevos** — chats genéricos y de tickets.
  - **Revisiones de código** — chats de revisión de PR, chats de reserva para nueva revisión, y notificaciones de revisión.

Más esfuerzo significa razonamiento más profundo y un uso de herramientas más exhaustivo, a mayor costo y latencia. Las revisiones a menudo quieren una profundidad distinta a las construcciones de funcionalidades — de ahí la división.

## Runtime y slots

Este panel controla la **retención de adjuntos**. (El dimensionamiento del pool de slots ahora es por repositorio y vive en [Repositorios](#repositorios) — ver la nota allí.)

![Runtime & slots](../../images/preferences_slots.png)

- **Conservar adjuntos durante** — cuánto tiempo se conservan en el almacenamiento propio de PopBot los archivos e imágenes que adjuntas a un chat (60 días por defecto, rango 1–365). Los adjuntos se copian al almacenamiento de PopBot para que sigan abriéndose desde el historial del chat incluso después de que el original se mueva; una limpieza al inicio elimina las copias más antiguas que esta ventana para que la carpeta no pueda crecer sin límite.

> La captura de pantalla de arriba puede ser anterior a la división del dimensionamiento del pool de slots hacia el flujo por repositorio.

## Repositorios

Cada chat vive en un **repositorio**. Este panel lista tus repositorios y es donde se configuran el control de código fuente, los slots, y los espacios de trabajo de copia en escritura por repositorio.

![Repositories](../../images/preferences_repositories.png)

- **Añadir repositorio** abre un asistente centrado en carpetas: elige una carpeta, y PopBot **detecta su control de código fuente** (Git o Perforce) y se ramifica según corresponda. Luego estableces un id, un color de acento, un prefijo de slot, y un conteo de slots.
  - Los repositorios **Git** eligen el modo **slots** (un pool reutilizado de espacios de trabajo — el por defecto, mostrado como `slots × N`) o **efímero** (un espacio de trabajo nuevo por chat). El modo slots mantiene las cachés de compilación en caliente entre chats.
  - Los repositorios **Perforce** siempre están en modo slot. El asistente captura la conexión P4, ejecuta una **verificación previa de disco**, y construye una **imagen base** congelada del árbol sincronizado; los slots luego se crean como hijos de copia en escritura de esa base (ver abajo).
- **Espacios de trabajo de copia en escritura.** El espacio de trabajo de un slot es una carpeta de copia en escritura que comparte una **imagen base** del repositorio y almacena solo los bloques que cambia, vía `shado` (la capa de espacio de trabajo sombra de PopBot): **VHDX diferencial** en Windows, copia en escritura nativa (APFS / reflink) en macOS y Linux. Diez slots en un árbol a escala de terabytes cuestan aproximadamente el disco de un repositorio más el pequeño delta de cada slot — lo que permite que árboles grandes de Perforce participen en absoluto. La imagen base se construye una vez, como un paso del asistente de Añadir repositorio.
- **El modo es permanente.** El modo slots-vs-efímero de un repositorio queda fijo en la creación; cambiarlo dejaría huérfanos los espacios de trabajo de los chats en curso.
- **Edita** un repositorio para cambiar su color de acento, la rama base por defecto (Git), o el directorio de trabajo del agente de Perforce, y para **Redimensionar slots** (crecer o reducir el pool un espacio de trabajo a la vez, condicionado a que todos los chats de ese repositorio estén cerrados).
- **Elimina** un repositorio; la confirmación te advierte si todavía hay chats que lo referencian.

Varios repositorios se ejecutan en paralelo, cada uno con su propio pool de slots y color de acento (el color tiñe las píldoras de slot de ese repositorio para que puedas distinguir los chats de un vistazo). Cada tarjeta de repositorio muestra su proveedor de control de código fuente y su modo.

## Control de código fuente

Configuraciones globales de control de código fuente y las plantillas de acciones editables. Los paneles de Git y Perforce se muestran uno junto al otro, porque el proveedor de un repositorio se detecta por carpeta y ambos pueden estar en uso a la vez.

![Source control](../../images/preferences_source_control.png)

- **Límite de archivos en vista de cambios** *(compartido)* — la cantidad máxima de archivos mostrados en la vista de cambios antes de que la lista se limite. Se aplica tanto a Git como a Perforce.

**Git**

- **Nombre de usuario de rama** — el prefijo para ramas nuevas: `<usuario>/<ticket>-<slug>`.
- **Plantillas de acciones** — los prompts que el panel SCM envía al agente para **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR**, y **Rebase onto base**. Cada una admite macros `${nombre}` (`${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, `${prurl}`…).

**Perforce**

- **Valores por defecto de conexión** — la ruta del binario `p4`, el puerto de servidor por defecto, y el usuario por defecto, que prellenan el paso de conexión Perforce del asistente de Añadir repositorio.
- **Opciones de transferencia / envío** — número de hilos de sincronización en paralelo, y si se revierten los archivos sin cambios al enviar (submit).
- **Intervalo de consulta de revisión de Swarm** — con qué frecuencia el panel de Revisiones consulta a Helix Swarm por changelists esperando tu revisión. Esto es **independiente de la consulta de GitHub** y tiene un **piso de 30 segundos**; auméntalo para aliviar la carga en un servidor Perforce/Swarm compartido a escala.
- **Plantillas de acciones de Perforce** — los prompts que el panel de Perforce envía al agente para **CR** (abrir/actualizar una revisión de Helix Swarm), **Ejecutar pruebas**, y **Revisar y confirmar**, cada una con macros `${nombre}`.

## Aplicaciones externas

Las aplicaciones de escritorio que PopBot lanza desde la fila de íconos de un chat, todas apuntando al espacio de trabajo del slot de ese chat.

![External apps](../../images/preferences_external_apps.png)

- **Terminal** — qué terminal abre el lanzador del ícono de terminal (por ejemplo, iTerm2).
- **Shell de terminal (Windows)** — el shell usado por el panel de terminal integrado: PowerShell, Símbolo del sistema, o PowerShell 7. Se aplica a las terminales abiertas después del cambio.
- **Editor de código** — VS Code o Cursor; también se usa para los enlaces clicables `file.ts:42` en las filas de la herramienta Edit.
- **Cliente Git** — por defecto GitHub Desktop.
- **Perfil de Chrome para URLs** — fija la apertura de enlaces a un perfil específico de Chrome (por el nombre de su *directorio* de perfil) para que siempre aterricen en tu cuenta de trabajo.

> Los binarios de motor y sus opciones de MCP se configuran en [Integraciones → Motores de videojuegos](#integraciones), no aquí.

## Plantillas de prompts

El primer mensaje que PopBot envía cuando se genera un chat. Cada plantilla es editable, con una tarjeta de referencia de las macros `${nombre}` disponibles para ella. (Las plantillas de acciones del panel SCM viven en [Control de código fuente](#control-de-código-fuente).)

![Prompt templates](../../images/preferences_prompt_templates.png)

- **Inicio de ticket** — se dispara cuando generas un chat desde un ticket, sin importar la fuente (Linear, Jira, o GitHub Issues). Las macros incluyen `${ticketid}`, `${tickettitle}`, `${markdown}`, `${branch}`, y `${slot}`.
- **Inicio de revisión de código** — se dispara cuando generas un chat desde una revisión — un PR de GitHub o un changelist de Helix Swarm. El valor por defecto dirige al agente a usar la skill de revisión, leer el código circundante (no solo el diff), y tratar el chat como de solo lectura.
- **Nueva revisión** — se dispara cuando vuelves a revisar un chat de revisión existente; delimita al agente solo a los commits nuevos.

Ajusta estas plantillas para codificar las convenciones, listas de verificación, y el tono de tu equipo.

## Revisiones de código

Controles para la bandeja de entrada de **Revisiones**. La cola muestra los PRs de GitHub y los changelists de Helix Swarm esperando tu revisión; los PRs que ya revisaste se eliminan automáticamente.

![Code reviews](../../images/preferences_code_reviews.png)

- **Ventana de caché de búsqueda** — cuántos días atrás el selector **+ Añadir** busca de forma difusa tickets y PRs recientes (más grande = más buscable, actualización ligeramente más lenta y más presupuesto de API). Los tickets asignados a ti siempre se incluyen sin importar este límite.
- **Ignorar por título** — subcadenas (una por línea, sin distinguir mayúsculas/minúsculas) que descartan un PR de la cola.
- **Ignorar por autor de GitHub** — logins de bot/autor (uno por línea, por ejemplo `renovate[bot]`) para silenciar.

> Las **tasas de consulta** de revisión se configuran por proveedor, no aquí: el intervalo de consulta de Helix Swarm vive en [Control de código fuente → Perforce](#control-de-código-fuente), independiente de la consulta de GitHub, así que un servidor Perforce/Swarm compartido puede protegerse sin ralentizar GitHub.

## Notificaciones

Cómo aparecen las alertas.

![Notifications](../../images/preferences_notifications.png)

- **Nombres VIP** — personas cuyos mensajes siempre se elevan a prioridad urgente. Se comparan como subcadenas sin distinguir mayúsculas/minúsculas del nombre para mostrar, así que mantén los nombres específicos.
- **Colocación de notificaciones emergentes** — *Centro superior, vuela a la campana al descartar* (por defecto), o notificaciones emergentes clásicas en la esquina superior derecha. El interruptor se aplica de inmediato.
- **Probar flujo de elemento nuevo** — marca temporalmente algunos elementos reales de la cola como NUEVO para previsualizar el comportamiento del chip/punto (nada se persiste). Esta es una ayuda de desarrollo temporal.

## Permisos

El valor por defecto global para cada herramienta de agente, y el piso bajo el modo autónomo.

![Permissions](../../images/preferences_permissions.png)

- Para cada herramienta (**Bash**, **Read**, **Write**, **Edit**, **Grep**, **Glob**, **WebFetch**, **WebSearch**, …): **Ask** (pregunta cada vez — por defecto), **Allow** (auto-aprobar), o **Deny** (auto-rechazar).
- **Autorizaciones por servidor MCP.** El servidor MCP del editor de un slot (Unity, Unreal, o cualquier servidor MCP que un agente cargue) puede permitirse de las mismas tres maneras. Permitir el MCP del editor de un slot una vez se recuerda, y el permiso es visible y revocable aquí — mostrado como `unityEditor → all tools` / `unrealEditor → all tools` en lugar del namespace crudo. PopBot habilita los MCPs del editor de Unity y Unreal de esta manera automáticamente; una regla por herramienta que difiera de un comodín se mantiene como excepción.
- Las reglas por chat (establecidas desde la tarjeta de permisos vía *Allow this chat* / *Deny this chat*) anulan estos valores globales, así que un solo chat puede bloquear una herramienta que de otro modo permitiste en todas partes.

> Un piso de denegación fija — `git push` / `p4 submit`, red a hosts no autorizados, cualquier cosa fuera del espacio de trabajo — vive en el código y **no** se puede anular aquí, así que una regla mal configurada no puede dejar que un agente aterrice en la rama principal por su cuenta.

## Idioma

La interfaz de PopBot está totalmente localizada.

- **Idioma de visualización** — cambia la configuración regional de la interfaz desde el menú de idioma, que lista cada idioma en su propio nombre. Las configuraciones regionales distribuidas son inglés, español, francés, alemán, chino (simplificado), japonés, coreano, y portugués (brasileño). La mayoría del texto y los menús se actualizan de inmediato; algunas cadenas del sistema terminan de actualizarse después de un reinicio. Las ventanas nuevas y el menú de la aplicación también usan este idioma.

---

Consulta la **[Guía de Funcionalidades y Flujos de Trabajo](GUIDE.md)** para ver cómo se desenvuelven estas configuraciones en flujos de trabajo reales.
