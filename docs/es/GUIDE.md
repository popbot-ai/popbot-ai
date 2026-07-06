# PopBot — Guía de Funcionalidades y Flujos de Trabajo

PopBot es una cabina de control de escritorio para ejecutar **muchos agentes de codificación con IA en paralelo**. Esta guía cubre las ideas sobre las que está construida — por qué existe, cómo funcionan las piezas, qué moldeó el diseño, y cómo un equipo en Proof of Play lo usó en un proyecto real, cargado de assets, que se lanzó al mercado. Está escrita para ingenieros que pueden encontrar la interfaz por sí mismos; el objetivo aquí es el razonamiento, para que puedas adaptar la herramienta a tu propio flujo de trabajo en lugar de seguir un guion.

Adaptarla a tu flujo de trabajo es un uso previsto, no una idea de último momento. PopBot se publica como una implementación de referencia — una forma para modificar según tu equipo en lugar de un producto fijo — reflejando una visión sobre cómo se construye mejor el software en la era de la IA: a los equipos que ejecutan flotas de agentes generalmente les conviene más ser dueños de la herramienta y remodelarla que adoptar una cuyas decisiones ya están fijadas para ellos. Lee el "por qué" detrás de cada pieza a continuación como un mapa de por dónde cortarías para cambiarla. [Hazlo tuyo](#hazlo-tuyo) cubre el cómo, dónde y por qué en detalle.

- [Por qué construimos PopBot](#por-qué-construimos-popbot)
- [Conceptos centrales](#conceptos-centrales)
  - [Agentes y modelos](#agentes-y-modelos)
  - [Slots: espacios de trabajo en caliente, aislados y desechables](#slots-espacios-de-trabajo-en-caliente-aislados-y-desechables)
  - [Copia en escritura: copias ilimitadas en el disco de un solo repositorio](#copia-en-escritura-copias-ilimitadas-en-el-disco-de-un-solo-repositorio)
  - [Control de código fuente: Git y Perforce](#control-de-código-fuente-git-y-perforce)
  - [La bandeja de entrada: una cola, muchas fuentes](#la-bandeja-de-entrada-una-cola-muchas-fuentes)
  - [Chats sin repositorio (para revisión de código)](#chats-sin-repositorio-para-revisión-de-código)
  - [Rama base](#rama-base)
  - [Chats persistentes y archivables](#chats-persistentes-y-archivables)
- [Anatomía del espacio de trabajo](#anatomía-del-espacio-de-trabajo)
- [Cómo se usó en Proof of Play](#cómo-se-usó-en-proof-of-play)
- [Flujos de trabajo de extremo a extremo](#flujos-de-trabajo-de-extremo-a-extremo)
  - [Un ticket de funcionalidad](#un-ticket-de-funcionalidad)
  - [Un ticket de bug](#un-ticket-de-bug)
  - [Una revisión de código](#una-revisión-de-código)
  - [Reabrir un chat archivado](#reabrir-un-chat-archivado)
- [Control de código fuente y revisión integrados](#control-de-código-fuente-y-revisión-integrados)
- [Pruebas en un slot: la aplicación bajo prueba](#pruebas-en-un-slot-la-aplicación-bajo-prueba)
- [Permisos y seguridad](#permisos-y-seguridad)
- [Localización](#localización)
- [Preferencias](#preferencias)
- [Hazlo tuyo](#hazlo-tuyo)

---

## Por qué construimos PopBot

Un único agente de codificación con IA es fácil de ejecutar. En el momento en que quieres **más de uno trabajando a la vez**, aparecen tres problemas:

1. **Aislamiento.** Dos agentes editando el mismo checkout corrompen el trabajo del otro. No puedes tener tres agentes y un solo árbol de trabajo — y en un proyecto de videojuego grande, tampoco puedes permitirte tres checkouts completos.
2. **Supervisión.** Los agentes son rápidos y en su mayoría acertados, pero "en su mayoría" no es suficiente para `git push`, `p4 submit`, o abrir un PR. Necesitas una barrera humana en las acciones irreversibles — sin tener que vigilar cada edición de archivo.
3. **Verificación.** El código que compila no es código que funciona. Para un videojuego especialmente, la única prueba real es *ejecutarlo* y recorrerlo con clics. Un agente que no puede ver la aplicación está adivinando.

PopBot se construyó para resolver los tres problemas para un equipo pequeño que lanzaba un videojuego en vivo. La idea: tratar cada unidad de trabajo — un ticket, un bug, una revisión — como un **chat**, darle a cada chat su propio **espacio de trabajo** aislado más (cuando se necesite) su propia copia en ejecución de la aplicación, ejecutarlos de forma **autónoma pero controlada**, y mostrar toda la flota en una sola ventana para que una persona pueda liderar una docena de agentes a la vez.

El diseño estuvo guiado por un conjunto concreto de [historias de usuario](USER_STORIES.md): *"Como ingeniero, hago clic en un ticket y un agente empieza a trabajarlo en una rama correcta."* *"Como revisor, abro un changelist y obtengo una revisión real sin tener que hacer checkout de nada."* *"Como líder, miro el tablero y sé qué agentes me necesitan."* Todo lo que sigue existe para servir a esas historias. Si entiendes *por qué* cada pieza tiene la forma que tiene, sabrás qué partes conservar y cuáles reemplazar cuando la bifurques (fork) para tu propia infraestructura.

---

## Conceptos centrales

### Agentes y modelos

Cada chat es impulsado por un **backend de agente**:

- **Claude Code** — vía el Claude Agent SDK. Modelos: **Claude Opus** (por defecto) y **Claude Fable**.
- **Codex** — vía el OpenAI Codex SDK. Modelo: **GPT / Codex**.

PopBot no reimplementa estos agentes — **impulsa a los reales** a través de sus SDKs oficiales, que envuelven las mismas herramientas de línea de comandos **`claude`** y **`codex`** que ejecutarías en una terminal. Todo el poder de cada agente — sus herramientas, skills, servidores MCP, y subagentes — está disponible dentro de cada chat, y PopBot se mantiene sincronizado con cualquier versión de esos CLIs que tengas instalada. Si funciona en Claude Code de terminal, funciona aquí. Es una apuesta deliberada: los agentes mejoran rápido, y cualquier cosa que los envolviera o bifurcara se quedaría obsoleta. Al impulsar los CLIs directamente, PopBot hereda cada mejora gratis.

Por chat, eliges el backend, el **modelo**, y el **esfuerzo de razonamiento** (`low` → `xhigh` / `max` — más esfuerzo significa pensamiento más profundo y uso de herramientas más exhaustivo, a mayor costo/latencia). Estableces **valores por defecto** sensatos — por separado para *chats nuevos* y para *revisiones de código*, ya que una revisión quiere una profundidad distinta a una construcción de funcionalidad — y los sobrescribes por chat cuando una tarea lo amerita.

Dos controles de sesión importan para el trabajo de larga duración:

- **Cambiar a mitad de sesión.** Cambia el modelo o el esfuerzo en un chat en curso; PopBot reconfigura al agente sin perder el hilo.
- **Reiniciar con contexto.** Levanta una sesión de agente *nueva* preparada con la transcripción de este chat (sus turnos iniciales más los más recientes), útil cuando una sesión se alarga demasiado o se atasca. El historial de la conversación se conserva; el agente simplemente obtiene un runtime limpio.

Las credenciales de las integraciones se almacenan **localmente en tu máquina**, en la propia base de datos de la aplicación — nunca en este repositorio.

### Slots: espacios de trabajo en caliente, aislados y desechables

Un **slot** es la unidad de paralelismo, y es la idea central en PopBot. La forma ingenua de ejecutar N agentes es N checkouts del repositorio — lo cual colisiona en árboles compartidos, o cuesta N × (tiempo de checkout + caché de compilación). Un slot es la respuesta a "cómo le das a un agente un lugar *real e independiente* para trabajar que además ya esté *en caliente* y sea *barato de devolver*".

Un slot tiene tres propiedades, y cada una es estructural:

- **Aislado.** Cada slot es su propio directorio de trabajo en su propia rama (o stream de Perforce), de modo que N agentes editan N ramas con cero interferencia. El `git reset` de un agente no puede tocar el trabajo de otro.
- **En caliente.** Un slot conserva artefactos de compilación con estado que persisten entre usos — para un motor de videojuegos, su propia caché de importación/assets; un **servidor sidecar** dedicado con su propio directorio de datos; **puertos** asignados; logs por slot; y, mientras un chat está activo, un proceso de **editor** en vivo. Un directorio de trabajo simple te da una *fuente* aislada; un slot te da un lugar aislado y ya *caliente* para compilar, ejecutar y probar.
- **Desechable.** Los slots se agrupan en un pool. Un chat **arrienda** un slot libre durante su vida útil y lo **devuelve** al cerrarse. Crear un espacio de trabajo en caliente es costoso; reutilizar uno es casi gratis, así que PopBot mantiene un pool de ellos en caliente y hace circular el trabajo a través de él.

**Por qué "en caliente" es todo el juego para el trabajo con motores de videojuegos.** Un motor de videojuegos mantiene una caché masiva de assets procesados — el `Library/` de Unity, el `DerivedDataCache` de Unreal — a menudo de varios gigabytes, costosa de producir. Un checkout nuevo, o un cambio de rama que la invalida, obliga al motor a **reimportar el proyecto**, lo que puede tardar muchos minutos. Si pagas eso en cada tarea y en cada cambio de rama, tus agentes pasan más tiempo esperando al motor que escribiendo código. Los slots eliminan ese impuesto dándole a cada uno su **propia caché persistente**:

- **Volver a cambiar un agente a su slot toma segundos, no minutos** — la caché ya está caliente, así que solo se reprocesan los assets realmente cambiados.
- **Un slot puede mantener el editor *en ejecución*.** Una reutilización "pegajosa" (mismo slot, misma rama) le entrega al agente un editor en vivo casi al instante en lugar de un arranque en frío.
- **Diez agentes no saturan una sola caché de importación.** Cada slot tiene su propia caché en caliente, así que el trabajo paralelo con el videojuego nunca se serializa detrás de una sola reimportación.

Antes de cualquier cambio de rama, PopBot ejecuta una **secuencia de seguridad** — guarda (stash) el trabajo sin confirmar, se niega a sobrescribir commits que el agente posee, cambia, y restaura el estado — de modo que un traspaso de slot nunca pierde trabajo silenciosamente. Los slots pueden ejecutarse en modo **pool de slots** (reutilizado, por defecto) o modo **efímero** (un espacio de trabajo nuevo por chat) cuando prefieras cambiar calidez por una pizarra limpia.

> **Por qué esto importa:** el aislamiento es lo que hace que "diez agentes a la vez" sea seguro en lugar de catastrófico. La calidez es lo que lo hace *rápido*. La desechabilidad es lo que lo hace *barato*. Quita cualquiera de los tres y los agentes en paralelo dejan de valer la pena.

### Copia en escritura: copias ilimitadas en el disco de un solo repositorio

El aislamiento y la calidez solo son asequibles si los *archivos* de un slot son baratos. En un repositorio pequeño, N worktrees de git están bien. En un proyecto de videojuego a escala de terabytes — con una biblioteca de assets enorme y, en muchos equipos, **Perforce** en lugar de Git — N copias reales serían cientos de gigabytes y minutos cada una para materializarse. Eso mata todo el modelo.

Así que el espacio de trabajo de un slot es una **carpeta de copia en escritura (copy-on-write)**. Cada slot comparte una **imagen base** del repositorio y almacena solo los bloques que realmente cambia. El resultado práctico:

- **Una copia completa, en vivo y actualizada de un árbol de un terabyte está lista en segundos** — no una vista superficial, archivos editables reales — y se libera igual de rápido.
- **Copias ilimitadas cuestan el disco de un solo repositorio.** Diez agentes en un proyecto de 1 TB no necesitan 10 TB; necesitan ~1 TB más el pequeño delta de cada slot.
- **Funciona igual en Windows, macOS y Linux** (vía `shado`, la capa de espacio de trabajo sombra de PopBot — VHDX diferencial en Windows, sistemas de archivos de copia en escritura nativos en el resto), y es lo que permite que los árboles de Perforce participen en absoluto.

Esta es la pieza que hace que la idea de slot escale desde "un repositorio web con unos pocos worktrees" hasta "un árbol de videojuego de tamaño AAA con una flota de agentes". También es la funcionalidad menos visible y posiblemente la más importante: sin copias baratas, los slots aislados en caliente son un lujo; con ellas, son la opción por defecto.

### Control de código fuente: Git y Perforce

PopBot trata el control de código fuente como un **proveedor** detrás de una interfaz común, porque "ejecutar un agente en una rama aislada, y luego revisar y aterrizar el cambio" tiene la misma forma sea el backend Git o Perforce. Ambos son de primera clase:

- **Git** — worktrees para el aislamiento, ramas por chat, PRs vía el CLI `gh`, GitHub como la superficie de revisión.
- **Perforce** — streams/ramas por chat sobre espacios de trabajo sombra de copia en escritura, changelists como la unidad de trabajo, y **Helix Swarm** como la superficie de revisión. Las revisiones de Swarm se anclan en la misma bandeja de entrada de Revisiones que los PRs de GitHub, cada una abriendo su propio chat de revisión.

Los conceptos que verás abajo — rama base, el panel git/SCM, acciones plantilla, la bandeja de entrada de revisión — están escritos contra esta interfaz común. Donde el texto dice "rama" o "PR," lee "changelist" o "revisión de Swarm" si estás en Perforce; el flujo de trabajo es deliberadamente idéntico.

### La bandeja de entrada: una cola, muchas fuentes

La bandeja de entrada es una *idea*, no una integración: **tu trabajo asignado y tus revisiones pendientes, clasificados, cada uno a un clic de convertirse en un chat de agente.** Lo que la alimenta es intercambiable:

- **Tickets** — issues de **Linear**, issues de **Jira**, y **GitHub Issues** asignados a ti (el soporte de GitHub Issues es más nuevo y todavía algo experimental). Haz clic en uno y PopBot nombra una rama, arrienda un slot, mueve el ticket a *En progreso*, y prepara al agente con su descripción.
- **Revisiones** — pull requests de **GitHub** y changelists de **Helix Swarm** esperando tu revisión. Haz clic en uno y un chat de revisión sin repositorio se abre al instante.

Añadir una fuente no cambia el flujo de trabajo — simplemente añade filas a la misma cola. Ese es el punto: el modelo de bandeja de entrada como cola es genérico, y los rastreadores específicos son valores por defecto intercambiables.

### Chats sin repositorio (para revisión de código)

No todos los chats necesitan un espacio de trabajo. **Revisar** un cambio es de solo lectura — no editas, lees el diff y el código circundante y publicas comentarios. Así que los chats de revisión son **sin repositorio**: se generan al instante, no arriendan ningún slot, y no consumen ningún espacio de trabajo.

Esta es una división deliberada e importante:

- Un **chat de construcción** (funcionalidad/bug) arrienda un slot, puede tardar un momento en calentarse, y mantiene un espacio de trabajo durante su vida útil.
- Un **chat de revisión** es **instantáneo y gratuito** — puedes abrir cinco de ellos para clasificar tu cola de revisión mientras tus chats de construcción siguen corriendo sin perturbarse.

También significa que tu pool de slots está reservado para el trabajo que realmente necesita aislamiento. Las revisiones nunca le quitan slots a las construcciones — una propiedad que importa mucho cuando el pool está limitado por RAM y disco.

### Rama base

Cuando un chat *sí* escribe código, bifurca desde una **base** — típicamente `develop`/`main` en Git, o el stream principal en Perforce. PopBot establece la base por defecto por repositorio, recuerda tu última elección para que el caso común sea un solo clic, y te permite bifurcar desde una línea de funcionalidad o rama de lanzamiento cuando una tarea lo necesita. Deriva el nombre de la nueva rama a partir de tu convención — por ejemplo, `<usuario>/<ticket>-<slug>` — de modo que las ramas sean consistentes y rastreables hasta su ticket. La base también impulsa acciones posteriores: "rebase sobre la base," "abrir PR / revisión contra la base," y las verificaciones de desviación (drift) todas dependen de ella.

### Chats persistentes y archivables

Cada chat es una **transcripción duradera** almacenada localmente — prosa, llamadas a herramientas, diffs, decisiones de permisos, todo. Nada es efímero.

- **Cerrar** un chat libera su slot (liberando un espacio de trabajo para otros agentes) pero **conserva todo**. El chat pasa al **archivo**.
- **Reabrir** un chat desde el archivo vuelve a arrendar un slot, restaura su rama, y el agente retoma con su **historial completo** — puedes retomar una funcionalidad días después para atender los comentarios de la revisión sin tener que reexplicar nada. Si se reabre en un slot *diferente*, PopBot se lo informa al agente de entrada, para que se reoriente limpiamente al nuevo directorio de trabajo.
- El archivo se puede buscar por nombre, ticket, rama, y contenido.

Como retroceder es simplemente "enviar otro mensaje" (no hay ediciones destructivas del historial), un chat acumula la historia completa y auditable de cómo se hizo un cambio.

---

## Anatomía del espacio de trabajo

![PopBot UI anatomy](../../images/anatomy.png)

| Región | Qué es |
|---|---|
| **Bandeja de entrada — tickets y revisiones** | Tickets asignados (Linear / Jira / GitHub Issues) y revisiones que te esperan (PRs de GitHub / changelists de Swarm), clasificados. Haz clic en una fila para generar un chat preparado con su contexto. |
| **Slots** | El pool de espacios de trabajo en caliente. Cada píldora muestra si un slot está libre o arrendado por un chat. |
| **Archivo de chats** | Cada chat pasado, con búsqueda y reapertura con historial completo. |
| **Miniaturas de chat** | Una vista previa en vivo y desplazable de cada chat abierto — una vista real de lo que cada agente está haciendo en este momento, codificada por color según el estado: azul = en ejecución, verde = terminado, amarillo = te necesita, rojo = error, gris = inactivo. |
| **Chats** | Las sesiones de agente enfocadas — prosa en streaming, llamadas a herramientas, y diffs de código en línea. |
| **Terminal por chat** | Una terminal integrada anclada al espacio de trabajo de ese chat. |
| **Panel SCM** | Estado del árbol de trabajo/changelist, commits recientes, diffs de archivos, y acciones de un clic para commit / push / PR / revisión. |

Debido a que cada chat permanece en la **franja de miniaturas** y las **columnas se ubican una junto a otra**, nunca estás buscando el estado. El color es la señal — azul = en ejecución, verde = terminado, amarillo = te necesita, rojo = error — así que un vistazo te dice qué agentes están trabajando, cuáles han terminado, y cuáles están **esperándote**.

Pero cada miniatura es también una **vista previa en vivo de la conversación**, no solo una luz de estado — así que de un vistazo puedes ver *en qué* está trabajando realmente cada agente. Eso es lo que te permite **detectar trabajo inútil a tiempo**: notar que un agente va por el camino equivocado y redirigirlo antes de que consuma tiempo y tokens, en lugar de descubrir el callejón sin salida después de que esté "terminado." Es la diferencia entre supervisar una flota y ser sorprendido por ella.

### Por qué miniaturas, y por qué una sola vista

Este diseño es una respuesta deliberada a un problema específico, y vale la pena exponer el razonamiento porque es la parte que más herramientas hacen mal.

Ejecutar un agente es una tarea de enfoque: observas una sola conversación y respondes. Ejecutar *muchos* es una tarea de **monitoreo**, y el monitoreo tiene un modo de fallo distinto — el cuello de botella no es tu velocidad de escritura, es tu atención. Un agente que se desvía silenciosamente produce trabajo que tienes que notar, entender, y descartar. Con N agentes, el costo de *no notar* escala con N, y las interfaces naturales dificultan notarlo: las pestañas ocultan a todos los agentes menos uno, y un modelo de lanzar-y-esperar los oculta a todos hasta que muestran un resultado.

Así que el diseño se compromete con dos cosas:

- **Cada agente está siempre visible.** La franja de miniaturas muestra toda la flota a la vez, y cada miniatura es una vista en vivo de la conversación real, no un indicador de carga. Está pensado para que puedas dar un paso atrás y captar el estado de una docena de agentes en un solo barrido de la vista — qué agentes se están moviendo, cuáles están atascados, cuáles están a punto de hacer algo que querrías detener.
- **El estado es un color, el contenido está a un vistazo.** El color responde "¿quién me necesita?" en menos de un segundo; la vista previa en vivo responde "¿qué está haciendo este?" sin un clic; y las columnas una junto a otra te permiten sumergirte en cualquiera de ellas sin perder las demás. La interfaz está optimizada para *volver a comprobar barato*, porque con muchos agentes vuelves a comprobar constantemente.

El resultado es la capacidad de **intervenir a tiempo**. El error costoso con agentes autónomos no es un fallo — es un agente gastando una hora con confianza construyendo lo equivocado. Una vista que muestra la intención continuamente convierte eso de un descubrimiento posterior en una corrección de rumbo a mitad de camino. Esa es toda la razón por la que la flota está en pantalla todo el tiempo en lugar de detrás de pestañas o una notificación.

---

## Cómo se usó en Proof of Play

PopBot no fue un experimento de laboratorio. Fue construido y usado a diario por el equipo en **Proof of Play** en un proyecto real, cargado de assets, que se lanzó al mercado. Ese origen explica la mayoría de las decisiones de diseño, y es la manera más clara de entender para qué sirve la herramienta.

El resultado práctico fue sencillo: el modelo de slots — espacios de trabajo en caliente, aislados, de copia en escritura — hizo factible el trabajo de agentes en paralelo en un árbol de assets grande, y el equipo logró hacer más gracias a ello. Múltiples agentes podían ejecutarse a la vez sin colisionar ni pagar el impuesto de reimportación del motor en cada cambio, así que el rendimiento aumentó en lugar de que el paralelismo se convirtiera en sobrecarga.

La forma de un día típico: un líder con el muro de miniaturas abierto, cuatro o cinco agentes en vuelo — un par avanzando en tickets de funcionalidades, uno persiguiendo un bug, uno o dos haciendo revisiones de código. El líder no está escribiendo código minuto a minuto; está **observando la flota**, interviniendo solo en las barreras (un push, un PR, una acción arriesgada) y cuando una miniatura se pone amarilla o un agente se desvía visiblemente. Los tickets vienen del rastreador real del equipo; las revisiones son PRs y changelists reales que el resto del equipo ve aterrizar.

Las restricciones estrictas que impuso ese proyecto de videojuego son exactamente las funcionalidades que terminaron importando más:

- **El árbol de assets era enorme**, así que los slots en caliente y los espacios de trabajo de copia en escritura no eran un lujo — sin ellos, una flota de agentes en ese árbol simplemente no era asequible. Por eso esas dos ideas son la columna vertebral de la herramienta.
- **El motor era la fuente de verdad para "¿funciona?"**, así que un agente que no pudiera lanzar y manejar el videojuego en ejecución era inútil para la mayoría del trabajo de gameplay. De ahí la integración de la aplicación bajo prueba.
- **El control de código fuente era Perforce para el videojuego y Git para las herramientas**, así que el SCM independiente del proveedor no era opcional.
- **Una persona necesitaba liderar a muchos agentes**, así que toda la cabina de control está optimizada para la *supervisión de un vistazo* en lugar del enfoque profundo en una sola sesión.

Si tu situación se parece a algo de eso — un árbol grande, una aplicación real que probar, más trabajo del que un agente puede manejar — el diseño se ajustará estrechamente a tus necesidades, porque fue construido exactamente para eso. Si no es así, la sección [Hazlo tuyo](#hazlo-tuyo) trata sobre mantener las ideas e intercambiar lo específico.

Una nota sobre el alcance: ese proyecto finalmente no encontró tracción comercial, y no estamos afirmando lo contrario. Pero el problema de ingeniería que planteaba era real — un árbol de assets grande, una flota de agentes, un equipo — y las partes de PopBot que lo resolvieron son las partes documentadas aquí. El valor de la herramienta no depende del resultado del videojuego, y preferimos decirlo con claridad antes que insinuar más.

---

## Flujos de trabajo de extremo a extremo

### Un ticket de funcionalidad

1. **Notificación → bandeja de entrada.** Un ticket asignado a ti aparece en la bandeja de entrada de **Tickets** (PopBot consulta Linear / Jira / GitHub Issues, clasificados por prioridad y fecha límite). La campana de notificaciones lo marca.
2. **Un clic para empezar.** Haz clic en la fila del ticket. PopBot abre un diálogo de **chat nuevo** por defecto en tu repositorio y base (recordados de la última vez) — confirma, o ajusta el agente/modelo/esfuerzo.
3. **Asignación de slot.** Como este chat escribirá código, PopBot **arrienda un slot**: elige un espacio de trabajo libre, deriva el nombre de la rama `you/eng-123-<slug>` a partir del ticket, y cambia el espacio de trabajo a él (ejecutando primero la secuencia de seguridad de stash).
4. **Ticket promovido automáticamente.** El ticket se mueve a **En progreso** automáticamente (idempotente, sin esperar confirmación) para que tu tablero refleje la realidad sin un cambio de contexto.
5. **El agente empieza.** El agente recibe un primer mensaje preparado (tu plantilla personalizable de *inicio de ticket*, completada con el título del ticket, la descripción, y la rama) y comienza: explorando el código, haciendo ediciones, ejecutando comandos — todo dentro del espacio de trabajo de su slot.
6. **Verificación en el slot.** Para un cambio de videojuego, el agente **lanza la aplicación en su slot** (un editor de motor + servidor sidecar en una segunda pantalla) y ejercita la funcionalidad — recorriendo la interfaz con clics, leyendo logs, tomando capturas de pantalla — en lugar de adivinar que funciona.
7. **Final controlado.** Cuando está listo para hacer push, el agente **se pausa** (hacer push es una acción controlada). La miniatura se pone amarilla ("te necesita").
8. **Revisas y publicas.** Abre el **panel SCM**, lee el diff, y presiona **Push PR** (o **Push draft**). La acción envía una instrucción prellenada al agente, que hace push de la rama y abre el PR / la revisión de Swarm contra tu base.

Durante todo esto, no estabas observando — estabas haciendo lo mismo con otros dos tickets. Solo interviniste en la barrera.

### Un ticket de bug

El flujo de bug es el flujo de funcionalidad con un ciclo más ajustado, y muestra el **paralelismo**:

1. Llega un reporte de bug (un ticket, o inicias un chat manualmente con la descripción del bug).
2. Genera un chat → arrienda **su propio** slot y rama. Tu chat de funcionalidad en curso queda completamente intacto — espacio de trabajo diferente, rama diferente.
3. El agente reproduce el bug **ejecutando la aplicación en su slot**, encuentra la causa, lo arregla, y vuelve a ejecutar para confirmar que la reproducción desapareció.
4. Miras la **franja de miniaturas**: chat de funcionalidad verde (terminado, esperando tu push), chat de bug azul (en ejecución). Dos agentes, dos árboles aislados, cero colisiones.
5. Haz push del arreglo cuando se pause esperando aprobación.

### Una revisión de código

1. **Notificación → Revisiones.** Un compañero de equipo solicita tu revisión. El PR (GitHub) o changelist (Swarm) aparece en la bandeja de entrada de **Revisiones**.
2. **Chat instantáneo, sin repositorio.** Haz clic en él → un **chat de revisión** se abre de inmediato — sin slot, sin checkout, sin espera. Está preparado con la plantilla de *inicio de revisión de código* (leer el código circundante, no solo el diff; rastrear los sistemas; buscar bugs reales, condiciones de carrera, casos límite, y problemas de seguridad y rendimiento).
3. **Revisión real.** El agente lee el diff **y** el código a su alrededor, razona sobre la corrección, y publica **comentarios en línea** más un veredicto (aprobar / solicitar cambios) en GitHub o Swarm — luego te resume las señales de alerta en el chat.
4. **Nueva revisión más tarde.** Si el autor hace push de arreglos, presiona **volver a revisar**: PopBot enfoca el chat de revisión existente y le dice al agente que mire **solo los commits nuevos**, verifique que cada hilo anterior esté realmente resuelto, y actualice su revisión.

Todo esto sucede mientras tus chats de construcción siguen corriendo — las revisiones nunca ocupan un slot.

### Reabrir un chat archivado

El trabajo rara vez se hace de una sola vez. El flujo de reapertura es de primera clase:

1. Un chat de funcionalidad publicó su PR; lo **cerraste** para liberar el slot. Ahora está en el **archivo** (transcripción totalmente conservada).
2. Dos días después, el cambio recibe comentarios de revisión. Encuentra el chat en el archivo (busca por ticket, rama, o texto) y **reábrelo**.
3. PopBot **vuelve a arrendar un slot**, restaura la rama del chat en el espacio de trabajo, y el agente retoma con su **historial completo** — ya sabe qué construyó y por qué. Si aterriza en un slot diferente al anterior, PopBot lo orienta al nuevo directorio de trabajo.
4. Pega o resume los comentarios de la revisión. El agente los atiende, vuelve a probar en el slot, y hace push de la actualización — sin reincorporación, sin contexto perdido.

Como la rama, la transcripción, y el razonamiento persisten todos, retomar una tarea cuesta segundos, no una nueva explicación.

---

## Control de código fuente y revisión integrados

El control de código fuente está conectado profundamente, a través del CLI nativo de cada proveedor — **`gh`/`git`** para GitHub, **`p4`** y la API de Swarm para Perforce — así que todo lo que hace un agente es actividad real que tu equipo ve en los lugares habituales.

- **Bandeja de entrada de revisiones.** Los PRs de GitHub y los changelists de Swarm esperando tu revisión (y tus propios envíos recientes) aparecen como fuentes de chat de un solo clic.
- **Chips de estado de PR / revisión.** Cada chat vinculado a un cambio muestra un chip de estado en vivo — Abierto / Fusionado / Cerrado / Borrador — en el que puedes hacer clic para abrirlo en GitHub o en Swarm.
- **El panel SCM.** Para cualquier chat de construcción, ve el estado del árbol de trabajo/changelist, los commits recientes, y los diffs por archivo. Haz clic en un archivo para una superposición completa de diff unificado.
- **Acciones de un clic.** Acciones plantilla y editables envían una instrucción prellenada al agente: **Commit**, **Push PR**, **Push draft PR**, **Make ready**, **Address CR** (atender comentarios de revisión), **Rebase onto base**. Cada una expande variables como `${branch}`, `${baseBranch}`, `${ticket}`, `${prnum}`, y `${prurl}` para que el agente tenga exactamente lo que necesita.
- **Creación contra tu base.** Hacer push abre el PR (o la revisión de Swarm) contra la base configurada del chat, nombrada según tu convención de ramas.

La revisión es una ruta distinta y optimizada (ver [Una revisión de código](#una-revisión-de-código)):

- **Sin repositorio e instantánea** — sin slot, sin checkout. Clasifica una cola de revisiones en segundos.
- **Lee contexto, no solo el diff** — la plantilla de revisión dirige al agente a leer el código circundante, rastrear sistemas, y buscar bugs/condiciones de carrera/casos límite/seguridad/rendimiento, no aprobar el parche automáticamente.
- **Publica donde tu equipo trabaja** — comentarios en línea y una revisión enviada en GitHub o Swarm.
- **La nueva revisión está delimitada** — en una segunda pasada, el agente examina solo los commits nuevos y confirma que cada hilo anterior esté genuinamente resuelto antes de actualizar su revisión.
- **Totalmente personalizable** — los prompts de *inicio de revisión de código* y de *nueva revisión* son plantillas editables, así que puedes ajustar el rigor, la lista de verificación, y el tono al nivel de tu equipo. El *procedimiento de revisión en sí* (cómo tu empresa quiere que se haga una revisión de GitHub o Perforce) es tuyo para proveer — PopBot recomienda y puede dar un ejemplo, pero el estándar vive con tu equipo.

## Pruebas en un slot: la aplicación bajo prueba

El slot de un chat de construcción no es solo una carpeta — es un lugar para **ejecutar e inspeccionar** el trabajo:

- **Terminal por chat.** Una terminal integrada (xterm + un PTY real) anclada al espacio de trabajo del chat. Ejecuta pruebas, inspecciona logs, o dispara comandos a mano mientras el agente trabaja. Persiste mientras cambias entre chats.
- **Integración con el editor.** Cada referencia `path/to/file.ts:42` en la transcripción es un enlace clicable que se abre en **VS Code** o **Cursor**, resuelto contra el espacio de trabajo del chat.
- **La aplicación bajo prueba.** Un slot puede lanzar la **aplicación real** para que el agente pueda manejarla en lugar de adivinar. Para una aplicación web, un CLI, o un servicio, esto es en su mayoría cosa del propio agente — ejecuta tus comandos de compilación y prueba en la terminal del slot, golpea el servidor en ejecución, lee la salida. PopBot no necesita saber nada especial sobre eso; el agente los maneja de la misma forma que tú lo harías. Los **motores** de videojuegos son el caso que necesita manejo extra, porque el editor es un proceso GUI de larga duración con su propia caché de assets y sin un bucle natural de "ejecutar y verificar" por línea de comandos. Así que para **Unity** y **Unreal**, PopBot lanza un editor en vivo + servidor sidecar, lo coloca en una segunda pantalla, y lo expone al agente a través de un **servidor MCP dentro del editor**. Cada editor en ejecución obtiene su **propio puerto MCP derivado de su slot** — así que un agente habla solo con *su* editor, nunca con el de otro slot — y PopBot conecta al agente de cada chat a ese endpoint automáticamente (en memoria, así que nada llega al control de código fuente). Un motor **personalizado** se integra en la misma maquinaria: PopBot pasa la identidad del slot a tu comando de lanzamiento y tú conectas cómo el agente lo maneja. En todos los casos el agente puede ejercitar la aplicación — hacer clic en la interfaz, leer logs, tomar capturas de pantalla, verificar comportamiento — y PopBot gestiona el ciclo de vida del editor (iniciar el servidor, verificar su salud, iniciar el editor, colocar su ventana, cerrarlo al liberarse), presupuestando las instancias concurrentes según la RAM disponible.

Esta es la diferencia entre un agente que *cree* que su cambio funciona y uno que lo *ha visto* funcionar. Nada de esto es específico de videojuegos — el desarrollo web y de otro tipo son usos igualmente de primera clase. Los motores de videojuegos simplemente cargan con el estado extra (una caché de assets en caliente, un editor como aplicación bajo prueba) del que el sistema tiene que ser consciente, y ese mismo estado extra es lo que los convierte en la demostración más clara de las partes novedosas de la herramienta: slots en caliente, espacios de trabajo de copia en escritura, y una aplicación en ejecución que el agente puede manejar.

## Permisos y seguridad

Autonomía con un piso firme:

- **Auto-permitido (silencioso):** lecturas, ediciones, y comandos de shell **dentro del espacio de trabajo del slot**, llamadas a los propios servicios del slot (incluyendo su MCP del editor), y operaciones internas del agente. El agente simplemente trabaja.
- **Siempre controlado (se pausa para ti):** `git push` / `p4 submit` / reset / force, cualquier cosa **fuera** del espacio de trabajo, abrir PRs o revisiones, eliminar fuera de un directorio temporal, enviar mensajes (Slack/correo), tocar la configuración del sistema o del agente, y llamadas de red a hosts no autorizados.
- **Todo lo demás:** te pide que decidas.

Cuando apruebas algo, puedes concederlo **una vez**, **para la sesión**, o **de forma duradera** (permitir siempre esta herramienta/objetivo). Los servidores MCP se pueden permitir de la misma manera — permite el MCP del editor de un slot una vez y se recuerda, con el permiso visible y revocable en Preferencias → Permisos (PopBot habilita los MCPs del editor de Unity/Unreal de esta manera automáticamente). Los permisos son por chat o globales y todos **revocables**. El piso de denegación fija (push/submit, red, fuera del árbol) vive en el código y no se puede anular desde la interfaz — así que un permiso mal configurado no puede dejar que un agente aterrice en la rama principal por su cuenta.

## Localización

Toda la interfaz de PopBot — menús, configuraciones, diálogos, todo — está totalmente localizada. La aplicación se distribuye en **doce idiomas**: inglés, español, francés, alemán, japonés, coreano, chino simplificado, portugués brasileño, ruso, italiano, polaco y ucraniano — intercambiables en cualquier momento desde el menú de idioma sin reiniciar. Si bifurcas (fork) PopBot, cada configuración regional es un solo catálogo de mensajes, así que añadir o ajustar un idioma es un cambio contenido en lugar de una búsqueda del tesoro por toda la interfaz.

## Preferencias

Todo se configura dentro de la aplicación (sin editar archivos de configuración):

- **Agentes** — modelo por defecto y esfuerzo de razonamiento, por separado para chats nuevos vs. revisiones de código.
- **Repositorios** — añade/edita repositorios vía un asistente centrado en carpetas y consciente del SCM: ruta, proveedor (Git/Perforce), rama base o stream, color, prefijo de slot, directorio de espacios de trabajo, modo pool de slots vs. efímero.
- **Runtime y slots** — tamaño del pool (cuántos agentes se ejecutan a la vez), pre-creación/eliminación de slots, retención de adjuntos, actualización de la imagen base para espacios de trabajo de copia en escritura.
- **Integraciones** — conecta Linear, Jira, GitHub, y Helix Swarm (credenciales almacenadas localmente); tasas de consulta de revisión configurables por proveedor; probar antes de guardar.
- **Control de código fuente** — convención de nombre de rama, base por defecto, y las plantillas de acciones editables.
- **Aplicaciones externas** — terminal (iTerm), editor (VS Code / Cursor), binarios de motor y opciones por motor (incluyendo el puerto base del MCP del editor), perfil opcional de Chrome para el enrutamiento de URLs.
- **Plantillas de prompts** — cada prompt sembrado (inicio de ticket, inicio/nueva revisión, y cada acción) es editable, con una tarjeta de referencia de variables.
- **Permisos** — revisa y revoca permisos duraderos, incluyendo autorizaciones por servidor MCP.
- **Notificaciones** — colocación de las notificaciones emergentes y comportamiento de alertas.
- **Idioma** — cambia la configuración regional de la interfaz.

> Para una referencia panel por panel con capturas de pantalla, consulta la **[Guía de Configuración](CONFIGURATION.md)**.

## Hazlo tuyo

Adaptar PopBot es un uso previsto principal. Se publica como una implementación de referencia, y su diseño refleja una visión sobre cómo se construye mejor el software en la era de la IA: un equipo toma una forma funcional, entiende *por qué* tiene esa forma, y la remodela alrededor de su propia infraestructura, herramientas, y convenciones en lugar de adoptar una herramienta cuyas decisiones ya están fijadas para ellos.

Su forma es general: **agentes + slots aislados, en caliente y de copia en escritura + una bandeja de entrada como cola + una aplicación bajo prueba.** Ese patrón aplica a la mayoría de los equipos que ejecutan más de un agente de codificación a la vez. Tiene **licencia MIT** y está estructurado para bifurcarse (fork) — el código está organizado como *proveedores detrás de pequeñas interfaces comunes*, así que una parte puede añadirse o intercambiarse sin tocar el resto. El enfoque general: mantén las ideas centrales, reemplaza las instancias específicas.

Las costuras se listan abajo con el *cómo, dónde, y por qué* de cada una. Cada una es una interfaz con implementaciones intercambiables; el camino práctico es tomar como referencia una implementación existente y añadir la tuya propia.

- **Cambia la aplicación bajo prueba.** *Por qué:* todo el punto es un agente que *ejecuta y verifica* tu aplicación, y "tu aplicación" es diferente para cada quien. *Dónde:* `src/shared/gameEngine.ts` (descriptores de motor, conexión MCP) y `src/main/ipc/apps.ts` (lanzamiento + ciclo de vida). Unity y Unreal son dos implementaciones; el gancho de **motor personalizado** ya pasa la identidad del slot (`POPBOT_SLOT`, puertos derivados) a tu comando de lanzamiento, así que conectar tu aplicación web, CLI, o arnés de pruebas es "completar el comando de lanzamiento y cómo el agente le habla."
- **Apunta la bandeja de entrada a otro lugar.** *Por qué:* la bandeja de entrada como cola es la idea duradera; el rastreador específico es un detalle. *Dónde:* `src/main/tickets/` — implementa la interfaz `TicketSource` en `provider.ts`, normaliza los datos de tu rastreador en los DTOs compartidos, y regístralo en `registry.ts` (el encabezado del archivo literalmente lo señala: *"añadir un rastreador es una sola línea aquí más su módulo `*Source.ts`"*). Linear, Jira, y GitHub Issues son los ejemplos ya resueltos. El renderer nunca se ramifica según el id del proveedor, así que no tocas la interfaz.
- **Añade o cambia el control de código fuente.** *Por qué:* "aislar un cambio, revisarlo, aterrizarlo" es independiente del proveedor; Git y Perforce son solo dos backends. *Dónde:* `src/main/scm/` — extiende la clase base `SourceControlProvider` (`provider.ts`), siguiendo `gitProvider.ts` / `perforceProvider.ts`. El comportamiento que no se abstrae limpiamente se **detecta por capacidades**, no con `if (provider === …)`, así que un VCS muy diferente puede incluso optar por su propia interfaz de cliente sin que quien lo llame tenga que hacer casos especiales.
- **Cambia la superficie de revisión.** *Por qué:* las revisiones deben aterrizar donde tu equipo ya mira. *Dónde:* los proveedores de revisión detrás de `src/main/reviews/` (PRs de GitHub vía `git/reviews.ts`, changelists de Swarm vía `p4/swarmReviews.ts`). El *procedimiento de revisión en sí* — cómo tu empresa quiere que se haga una revisión — deliberadamente **no** viene incluido en la herramienta; es una skill propia de tu empresa que tú provees, así que PopBot recomienda y da ejemplos pero nunca impone tu estándar.
- **Reconecta las acciones y los prompts.** *Por qué:* las convenciones de ramas, los flujos de PR/revisión, y cómo instruyes a un agente son específicos de cada equipo. *Dónde:* no se necesita código — las plantillas de acciones de git y cada prompt sembrado (inicio de ticket, inicio/nueva revisión) son **editables en Preferencias**, con una tarjeta de referencia de variables. Cambia el rigor, la lista de verificación, el tono.
- **Conserva el núcleo.** *Por qué:* estas son las ideas que hacen que todo funcione, y son las partes que deberías cambiar más despacio. Los slots en caliente, los espacios de trabajo de copia en escritura (`src/main/shado/`), los chats persistentes, el piso de permisos fijo en el código, y la cabina de control de agentes en paralelo son la columna vertebral duradera. Todo lo demás está pensado para moverse.

Para los límites de procesos, el IPC, y dónde vive cada subsistema, lee el documento de **[Arquitectura](ARCHITECTURE.md)** — el mapa para encontrar la costura que quieres cambiar. Para el modelo de objetos (Chat, Slot, AgentSession y sus ciclos de vida), consulta el **[Modelo Central](CORE_MODEL.md)**.

Para los equipos que ejecutan más de un agente a la vez, este es un punto de partida funcional pensado para ser desarmado y reconstruido alrededor de un flujo de trabajo diferente.

---

*Algunas integraciones referenciadas en la [especificación de diseño](POPBOT_DESIGN.md) original (Slack, Sentry, y otras) existen como conexiones esbozadas en lugar de flujos completos; Linear, Jira, GitHub, y Helix Swarm son las fuentes de bandeja de entrada completamente conectadas. Esta guía describe cómo se comporta realmente la aplicación hoy.*
