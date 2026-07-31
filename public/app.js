const documentoInput = document.getElementById('documento');
const btnBuscar = document.getElementById('btn-buscar');
const dniStatus = document.getElementById('dni-status');

const vistaServicio = document.getElementById('vista-servicio');
const btnEditar = document.getElementById('btn-editar');
const mensajeBienvenida = document.getElementById('mensaje-bienvenida');
const serviciosGrid = document.getElementById('servicios-grid');
const otrosPanel = document.getElementById('otros-panel');
const otrosServicioInput = document.getElementById('otros-servicio');
const btnRegistrarOtros = document.getElementById('btn-registrar-otros');
const btnCancelarOtros = document.getElementById('btn-cancelar-otros');
const btnCancelarAsistencia = document.getElementById('btn-cancelar-asistencia');
const asistenciaMessage = document.getElementById('asistencia-message');

const vistaNoEncontrado = document.getElementById('vista-no-encontrado');
const btnRegistrarme = document.getElementById('btn-registrarme');

const form = document.getElementById('registro-form');
const tipoDocInput = document.getElementById('tipo-doc');
const pacienteInput = document.getElementById('paciente');
const apodoInput = document.getElementById('apodo');
const rucInput = document.getElementById('ruc');
const celularInput = document.getElementById('celular');
const distritoInput = document.getElementById('distrito');
const fNacimientoInput = document.getElementById('f-nacimiento');
const edadInput = document.getElementById('edad');
const sexoInput = document.getElementById('sexo');
const correoInput = document.getElementById('correo');
const direccionInput = document.getElementById('direccion');
const btnCancelar = document.getElementById('btn-cancelar');
const formMessage = document.getElementById('form-message');

const toast = document.getElementById('toast');

let clienteActual = null; // último cliente encontrado para este documento (o null)

async function cargarDistritos() {
  try {
    const res = await fetch('/api/distritos');
    const nombres = await res.json();
    nombres.forEach((nombre) => {
      const option = document.createElement('option');
      option.value = nombre;
      option.textContent = nombre;
      distritoInput.appendChild(option);
    });
  } catch (err) {
    // La lista se queda solo con "Seleccioná un distrito" si falla.
  }
}
cargarDistritos();

function mostrarToast(mensaje) {
  toast.textContent = mensaje;
  toast.classList.remove('hidden');
  // reflow so the animation restarts if a toast is already showing
  void toast.offsetWidth;
  toast.classList.add('visible');
  clearTimeout(mostrarToast._timer);
  mostrarToast._timer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.classList.add('hidden'), 250);
  }, 3000);
}

function calcularEdad(fNacimientoISO) {
  if (!fNacimientoISO) return '';
  const nacimiento = new Date(`${fNacimientoISO}T00:00:00Z`);
  if (Number.isNaN(nacimiento.getTime())) return '';
  const hoy = new Date();
  let edad = hoy.getUTCFullYear() - nacimiento.getUTCFullYear();
  const aunNoCumplio =
    hoy.getUTCMonth() < nacimiento.getUTCMonth() ||
    (hoy.getUTCMonth() === nacimiento.getUTCMonth() && hoy.getUTCDate() < nacimiento.getUTCDate());
  if (aunNoCumplio) edad -= 1;
  return `${Math.max(edad, 0)} años`;
}

fNacimientoInput.addEventListener('input', () => {
  edadInput.value = calcularEdad(fNacimientoInput.value);
});

function limpiarFormulario() {
  tipoDocInput.value = 'DNI';
  pacienteInput.value = '';
  apodoInput.value = '';
  rucInput.value = '';
  celularInput.value = '';
  distritoInput.value = '';
  fNacimientoInput.value = '';
  edadInput.value = '';
  sexoInput.value = '';
  correoInput.value = '';
  direccionInput.value = '';
  formMessage.textContent = '';
  formMessage.className = 'message';
}

function ocultarTodo() {
  vistaServicio.classList.add('hidden');
  vistaNoEncontrado.classList.add('hidden');
  form.classList.add('hidden');
}

// Vuelve a la pantalla inicial de búsqueda, lista para el próximo documento
// (útil tanto al cancelar como después de un check-in, como en un kiosco).
function mostrarBusquedaInicial() {
  clienteActual = null;
  ocultarTodo();
  limpiarFormulario();
  documentoInput.readOnly = false;
  documentoInput.value = '';
  dniStatus.textContent = '';
  dniStatus.className = 'status';
  documentoInput.focus();
}

function ocultarOtrosPanel() {
  otrosPanel.classList.add('hidden');
  serviciosGrid.classList.remove('hidden');
}

function mostrarVistaServicio(cliente) {
  documentoInput.readOnly = false;
  mensajeBienvenida.textContent = `¡Hola, ${cliente.apodo || cliente.paciente}! ¿A qué servicio vienes hoy?`;
  ocultarTodo();
  vistaServicio.classList.remove('hidden');
  ocultarOtrosPanel();
  asistenciaMessage.textContent = '';
  asistenciaMessage.className = 'message';
}

function mostrarNoEncontrado() {
  documentoInput.readOnly = false;
  ocultarTodo();
  vistaNoEncontrado.classList.remove('hidden');
}

function mostrarFormulario({ editando }) {
  ocultarTodo();
  form.classList.remove('hidden');
  btnCancelar.classList.toggle('hidden', !editando);
  // El documento es la clave del registro — no se debe poder cambiar al
  // actualizar uno ya existente. Sí se puede corregir al crear uno nuevo.
  documentoInput.readOnly = editando;

  if (editando && clienteActual) {
    tipoDocInput.value = clienteActual.tipo_doc || 'DNI';
    pacienteInput.value = clienteActual.paciente || '';
    apodoInput.value = clienteActual.apodo || '';
    rucInput.value = clienteActual.ruc || '';
    celularInput.value = clienteActual.celular || '';
    distritoInput.value = clienteActual.distrito || '';
    fNacimientoInput.value = clienteActual.f_nacimiento || '';
    edadInput.value = calcularEdad(clienteActual.f_nacimiento);
    sexoInput.value = clienteActual.sexo || '';
    correoInput.value = clienteActual.correo || '';
    direccionInput.value = clienteActual.direccion || '';
    formMessage.textContent = '';
    formMessage.className = 'message';
  } else {
    limpiarFormulario();
  }
}

let lookupTimer = null;
const BUSQUEDA_DEBOUNCE_MS = 1500;

documentoInput.addEventListener('input', () => {
  clearTimeout(lookupTimer);
  clienteActual = null;
  ocultarTodo();
  dniStatus.textContent = '';
  dniStatus.className = 'status';

  const documento = documentoInput.value.trim();
  if (documento.length < 3) return;

  // Esperamos a que la persona termine de tipear (los documentos tienen
  // largos distintos: DNI, CE, RUC, pasaporte) antes de disparar la búsqueda,
  // para que la pantalla no cambie mientras todavía está escribiendo.
  lookupTimer = setTimeout(() => buscarDocumento(documento), BUSQUEDA_DEBOUNCE_MS);
});

documentoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(lookupTimer);
    buscarDocumento(documentoInput.value.trim());
  }
});

btnBuscar.addEventListener('click', () => {
  clearTimeout(lookupTimer);
  buscarDocumento(documentoInput.value.trim());
});

async function buscarDocumento(documento) {
  if (!documento) return;
  dniStatus.textContent = 'Buscando...';
  dniStatus.className = 'status';

  try {
    const res = await fetch(`/api/lookup/${encodeURIComponent(documento)}`);
    const data = await res.json();

    if (data.found) {
      clienteActual = data.cliente;
      dniStatus.textContent = '';
      dniStatus.className = 'status';
      mostrarVistaServicio(clienteActual);
    } else {
      clienteActual = null;
      dniStatus.textContent = '';
      dniStatus.className = 'status';
      mostrarNoEncontrado();
    }
  } catch (err) {
    dniStatus.textContent = 'Error al buscar';
    dniStatus.className = 'status not-found';
  }
}

btnEditar.addEventListener('click', () => {
  mostrarFormulario({ editando: true });
});

btnRegistrarme.addEventListener('click', () => {
  mostrarFormulario({ editando: false });
});

btnCancelar.addEventListener('click', () => {
  mostrarBusquedaInicial();
});

btnCancelarAsistencia.addEventListener('click', () => {
  mostrarBusquedaInicial();
});

async function registrarAsistencia(area, servicio) {
  asistenciaMessage.textContent = '';
  asistenciaMessage.className = 'message';

  try {
    const res = await fetch('/api/asistencias', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        NRO_DOC: clienteActual.documento,
        AREA: area,
        SERVICIO: servicio,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al registrar asistencia');

    const a = data.asistencia;
    mostrarToast(`Asistencia registrada: ${a.servicio} (${a.turno}) a las ${a.hora_atencion}`);
    mostrarBusquedaInicial();
  } catch (err) {
    asistenciaMessage.textContent = err.message;
    asistenciaMessage.className = 'message error';
  }
}

serviciosGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-servicio');
  if (!btn) return;

  if (btn.id === 'btn-otros') {
    otrosPanel.classList.remove('hidden');
    serviciosGrid.classList.add('hidden');
    otrosServicioInput.value = '';
    otrosServicioInput.focus();
    return;
  }

  registrarAsistencia(btn.dataset.area, btn.dataset.servicio);
});

btnRegistrarOtros.addEventListener('click', () => {
  const servicio = otrosServicioInput.value.trim();
  if (!servicio) {
    asistenciaMessage.textContent = 'Escribí qué servicio es.';
    asistenciaMessage.className = 'message error';
    return;
  }
  registrarAsistencia('Estética', servicio);
});

btnCancelarOtros.addEventListener('click', () => {
  ocultarOtrosPanel();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formMessage.textContent = '';
  formMessage.className = 'message';

  const eraActualizacion = Boolean(clienteActual);
  const documento = documentoInput.value.trim();
  if (!documento) {
    formMessage.textContent = 'Ingresá un documento.';
    formMessage.className = 'message error';
    return;
  }

  const payload = {
    DOCUMENTO: documento,
    TIPO_DOC: tipoDocInput.value,
    PACIENTE: pacienteInput.value.trim(),
    APODO: apodoInput.value.trim(),
    RUC: rucInput.value.trim(),
    CELULAR: celularInput.value.trim(),
    DISTRITO: distritoInput.value.trim(),
    F_NACIMIENTO: fNacimientoInput.value,
    SEXO: sexoInput.value,
    CORREO: correoInput.value.trim(),
    DIRECCION: direccionInput.value.trim(),
  };

  try {
    const res = await fetch('/api/clientes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Error al guardar');

    clienteActual = data.cliente;
    mostrarToast(eraActualizacion ? 'Datos actualizados correctamente' : 'Cliente guardado correctamente');
    mostrarVistaServicio(clienteActual);
  } catch (err) {
    formMessage.textContent = err.message;
    formMessage.className = 'message error';
  }
});
