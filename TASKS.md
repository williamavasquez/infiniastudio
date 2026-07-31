# Tareas pendientes

Fuente: feedback de Nacho Meza (WhatsApp, 2026-07-27). Agrupado por área para facilitar el trabajo.

## Flujo del formulario principal (front)

- [X] Quitar el título "Formulario de Registro" por completo
- [X] Reemplazar la pantalla inicial por algo simple: "¡Bienvenido a Infinia!" + "Ingresa tu DNI para comenzar" + campo DNI + botón BUSCAR
- [X] Cuando el DNI se encuentra, mostrar directamente "¡Hola, {Nombre}!" + "¿A qué servicio vienes hoy?" (no un saludo genérico separado)
- [X] Eliminar el botón intermedio "Registrar Asistencia" — pasar directo de la pantalla de bienvenida a la selección de servicio
- [X] Reemplazar el grupo de 4 categorías actuales por dos bloques visuales separados:
  - **PILATES**: Clase Grupal, Clase Personalizada, Clase Teens, Clase Senior
  - **ESTÉTICA**: Consulta Estética, Sesión INDIBA, Sesión Onda Coolwaves, Sesión Emerald, Otros
- [X] Al hacer clic en cualquier servicio, registrar la asistencia inmediatamente (sin botón adicional de "Confirmar")
- [X] Mostrar siempre ambos bloques (Pilates y Estética) juntos, sin importar cuál se seleccione (venta cruzada)
- [X] "Otros" debe abrir un campo de texto libre para especificar el servicio real; guardar ese texto en vez de la palabra literal "Otros"
- [X] Reemplazar el mensaje frío de "no encontrado" por: "¡Aún no te encontramos!" + "Parece que es tu primera vez en Infinia. Completa tus datos para registrarte." + botón "Registrarme"
- [X] Después de registrar un cliente nuevo, pasar directo a la pantalla de selección de servicio ("¡Hola, {Nombre}! ¿A qué servicio vienes hoy?"), no a una pantalla de bienvenida genérica

## Modelo de datos / esquema

- [X] Agregar campo "Sexo" a la tabla `clientes` y al formulario
- [X] Quitar el campo RUC del formulario de clientes — se ocultó de la UI (front y Admin), la columna sigue en la BD y se preserva si ya tenía un valor cargado
- [X] Cambiar la pregunta del campo "Apodo" en el front a "¿Cómo prefieres que te llamemos?"; en el Admin se muestra como "Nombre preferido" (la columna interna `apodo` queda igual, solo cambió la etiqueta)
- [X] Reestructurar "categoria" (4 opciones planas) en dos campos: **Área** (Pilates / Estética) y **Servicio** (el servicio específico elegido, incluyendo el texto libre de "Otros") — `categoria` queda en la tabla solo por compatibilidad histórica, ya no se usa
- [X] Confirmar que Edad siga siendo siempre calculada automáticamente desde fecha de nacimiento (nunca ingresada a mano) — el form ya lo hacía; el listado de Usuarios del Admin ahora también la calcula al vuelo con SQL (`AGE(f_nacimiento)`), nunca se guarda

## Lógica de negocio: clientes únicos vs. servicios

- [X] Definir "cliente único" = contado por DOCUMENTO (distinct), sin importar cuántos servicios/visitas tuvo ese día
- [X] Definir "servicio realizado" = contado por cada fila de asistencia (todas las filas, sin deduplicar) — también se agregó "asistencias" = visitas distintas (documento+fecha), para diferenciar de clientes únicos cuando el rango de fechas es mayor a un día
- [X] Aplicar esta distinción de forma consistente en: stats del Dashboard, stats de la página de Asistencias (`getResumenAsistencias` es la única función que calcula esto, reusada en ambos lados)
- [X] Caso de validación: 1 cliente con 2 servicios el mismo día (Clase Grupal + Sesión INDIBA) → Clientes únicos = 1, Servicios realizados = 2, Pilates = 1, Estética = 1 — probado exactamente así, resultado correcto

## Admin: Dashboard

- [X] Agregar filtro de fechas arriba: Hoy / Ayer / 7 días / Este mes / Mes anterior / Rango de fechas (custom)
- [X] Agregar/actualizar stats según ese filtro: Clientes únicos, Asistencias, Servicios realizados, Pilates, Estética
- [X] Se mantiene la lista de "últimos 20 clientes" junto con los nuevos stats (no depende del filtro de fecha, siempre son los últimos 20 por fecha de registro)

## Admin: Usuarios

- [X] Actualizar campos visibles/editables a: Documento | Tipo de documento | Paciente | Nombre preferido | Celular | Distrito | Fecha de nacimiento | Edad | Sexo | Correo | Dirección | Fecha de registro
- [X] Quitar la columna RUC de la tabla y del export de Usuarios
- [X] Actualizar el buscador para que busque por documento, nombre (paciente), celular y correo
- [X] Actualizar columnas del CSV export para que coincidan con la nueva lista de campos (quitar RUC, agregar Sexo y Edad, renombrar columna Apodo a "Nombre preferido")

## Admin: Asistencias (renombrar de "Check-ins")

- [X] Renombrar la pestaña/página de "Check-ins" a "Asistencias" (el tab ahora dice "Asistencias"; los ids internos siguen siendo `checkins-*`, sin impacto visible)
- [X] La vista por defecto muestra solo las asistencias del día (el filtro Desde/Hasta se prellena con "hoy" en Perú vía `/api/admin/hoy`); nada se elimina — el histórico completo sigue disponible cambiando el rango
- [X] Actualizar columnas de la tabla a: Fecha | Hora | Turno | Documento | Cliente | Distrito | Área | Servicio
- [X] Mantener Turno auto-calculado: Mañana hasta las 2:00pm, Tarde después de las 2:00pm hasta el cierre (ya existía, columnas/etiquetas confirmadas alineadas)
- [X] Actualizar filtros a: documento o cliente (búsqueda), distrito, área, servicio, rango de fechas
- [X] Agregar 3 números de resumen arriba de la tabla: Clientes únicos | Asistencias | Servicios realizados (misma lógica que el Dashboard, se recalculan solos al cambiar cualquier filtro)
