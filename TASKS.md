# Tareas pendientes

Fuente: feedback de Nacho Meza (WhatsApp, 2026-07-27). Agrupado por área para facilitar el trabajo.

## Flujo del formulario principal (front)

- [X] Quitar el título "Formulario de Registro" por completo
- [X] Reemplazar la pantalla inicial por algo simple: "¡Bienvenido a Infinia!" + "Ingresa tu DNI para comenzar" + campo DNI + botón BUSCAR
- [ ] Cuando el DNI se encuentra, mostrar directamente "¡Hola, {Nombre}!" + "¿A qué servicio vienes hoy?" (no un saludo genérico separado) — *depende de la reestructura Área/Servicio de abajo*
- [ ] Eliminar el botón intermedio "Registrar Asistencia" — pasar directo de la pantalla de bienvenida a la selección de servicio — *depende de la reestructura Área/Servicio*
- [ ] Reemplazar el grupo de 4 categorías actuales por dos bloques visuales separados:
  - **PILATES**: Clase Grupal, Clase Personalizada, Clase Teens, Clase Senior
  - **ESTÉTICA**: Consulta Estética, Sesión INDIBA, Sesión Onda Coolwaves, Sesión Emerald, Otros
- [ ] Al hacer clic en cualquier servicio, registrar la asistencia inmediatamente (sin botón adicional de "Confirmar")
- [ ] Mostrar siempre ambos bloques (Pilates y Estética) juntos, sin importar cuál se seleccione (venta cruzada)
- [ ] "Otros" debe abrir un campo de texto libre para especificar el servicio real; guardar ese texto en vez de la palabra literal "Otros"
- [X] Reemplazar el mensaje frío de "no encontrado" por: "¡Aún no te encontramos!" + "Parece que es tu primera vez en Infinia. Completa tus datos para registrarte." + botón "Registrarme"
- [ ] Después de registrar un cliente nuevo, pasar directo a la pantalla de selección de servicio ("¡Hola, {Nombre}! ¿A qué servicio vienes hoy?"), no a una pantalla de bienvenida genérica — *depende de la reestructura Área/Servicio*

## Modelo de datos / esquema

- [ ] Agregar campo "Sexo" a la tabla `clientes` y al formulario
- [ ] Quitar el campo RUC del formulario de clientes (confirmar si se elimina la columna o solo se oculta de la UI)
- [ ] Cambiar la pregunta del campo "Apodo" en el front a "¿Cómo prefieres que te llamemos?"; en el Admin mostrarlo como "Nombre preferido" (la columna interna `apodo` puede quedar igual, solo cambia la etiqueta — confirmar)
- [ ] Reestructurar "categoria" (4 opciones planas) en dos campos: **Área** (Pilates / Estética) y **Servicio** (el servicio específico elegido, incluyendo el texto libre de "Otros")
- [ ] Confirmar que Edad siga siendo siempre calculada automáticamente desde fecha de nacimiento (nunca ingresada a mano) — ya es así en el form, verificar también en el listado de Usuarios del Admin

## Lógica de negocio: clientes únicos vs. servicios

- [ ] Definir "cliente único" = contado por DOCUMENTO (distinct), sin importar cuántos servicios/visitas tuvo ese día
- [ ] Definir "servicio realizado" = contado por cada fila de asistencia (todas las filas, sin deduplicar)
- [ ] Aplicar esta distinción de forma consistente en: stats del Dashboard, stats de la página de Asistencias, y cualquier reporte futuro
- [ ] Caso de validación: 1 cliente con 2 servicios el mismo día (Clase Grupal + Sesión INDIBA) → Clientes únicos = 1, Servicios realizados = 2, Pilates = 1, Estética = 1

## Admin: Dashboard

- [ ] Agregar filtro de fechas arriba: Hoy / Ayer / 7 días / Este mes / Mes anterior / Rango de fechas (custom)
- [ ] Agregar/actualizar stats según ese filtro: Clientes únicos, Asistencias, Servicios realizados, Pilates, Estética
- [ ] Confirmar con Nacho si se mantiene la lista de "últimos 20 clientes" junto con los nuevos stats

## Admin: Usuarios

- [ ] Actualizar campos visibles/editables a: Documento | Tipo de documento | Paciente | Nombre preferido | Celular | Distrito | Fecha de nacimiento | Edad | Sexo | Correo | Dirección | Fecha de registro
- [ ] Quitar la columna RUC de la tabla y del export de Usuarios
- [ ] Actualizar el buscador para que busque por documento, nombre (paciente), celular y correo (actualmente solo busca documento/paciente)
- [ ] Actualizar columnas del CSV export para que coincidan con la nueva lista de campos (quitar RUC, agregar Sexo, renombrar columna Apodo a "Nombre preferido")

## Admin: Asistencias (renombrar de "Check-ins")

- [ ] Renombrar la pestaña/página de "Check-ins" a "Asistencias"
- [ ] La vista por defecto muestra solo las asistencias del día (pero nada se elimina — el histórico completo sigue disponible para consultar)
- [ ] Actualizar columnas de la tabla a: Fecha | Hora | Turno | Documento | Cliente | Distrito | Área | Servicio
- [ ] Mantener Turno auto-calculado: Mañana hasta las 2:00pm, Tarde después de las 2:00pm hasta el cierre (la lógica ya existe — solo confirmar que las columnas/etiquetas queden alineadas)
- [ ] Actualizar filtros a: documento o cliente (búsqueda), distrito, área, servicio, rango de fechas
- [ ] Agregar 3 números de resumen arriba de la tabla: Clientes únicos | Asistencias | Servicios realizados (misma lógica de deduplicación que el Dashboard)
