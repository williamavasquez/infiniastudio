const dniInput = document.getElementById('dni');
const dniStatus = document.getElementById('dni-status');

const vistaEncontrado = document.getElementById('vista-encontrado');
const btnEditar = document.getElementById('btn-editar');
const mensajeBienvenida = document.getElementById('mensaje-bienvenida');

const form = document.getElementById('registro-form');
const fechaInput = document.getElementById('fecha');
const nombreInput = document.getElementById('nombre');
const apellidoInput = document.getElementById('apellido');
const fechaNacimientoInput = document.getElementById('fecha-nacimiento');
const btnCancelar = document.getElementById('btn-cancelar');
const formMessage = document.getElementById('form-message');

let registroActual = null; // último registro encontrado para este DNI (o null)

function today() {
  return new Date().toISOString().slice(0, 10);
}

function limpiarFormulario() {
  fechaInput.value = today();
  nombreInput.value = '';
  apellidoInput.value = '';
  fechaNacimientoInput.value = '';
  formMessage.textContent = '';
  formMessage.className = 'message';
}

function mostrarVistaEncontrado(registro) {
  mensajeBienvenida.textContent = `Bienvenido/a ${registro.Nombre} ${registro.Apellido}`;

  vistaEncontrado.classList.remove('hidden');
  form.classList.add('hidden');
}

function mostrarFormulario({ editando }) {
  vistaEncontrado.classList.add('hidden');
  form.classList.remove('hidden');
  btnCancelar.classList.toggle('hidden', !editando);

  if (editando && registroActual) {
    fechaInput.value = registroActual.Fecha || today();
    nombreInput.value = registroActual.Nombre || '';
    apellidoInput.value = registroActual.Apellido || '';
    fechaNacimientoInput.value = registroActual.FechaNacimiento || '';
  } else {
    limpiarFormulario();
  }
}

function ocultarTodo() {
  vistaEncontrado.classList.add('hidden');
  form.classList.add('hidden');
}

let lookupTimer = null;

const DNI_LENGTH = 8;

dniInput.addEventListener('input', () => {
  clearTimeout(lookupTimer);
  const dni = dniInput.value.trim();
  dniStatus.textContent = '';
  dniStatus.className = 'status';
  registroActual = null;
  ocultarTodo();

  if (dni.length < DNI_LENGTH) return;

  lookupTimer = setTimeout(() => buscarDni(dni), 350);
});

async function buscarDni(dni) {
  dniStatus.textContent = 'Buscando...';
  dniStatus.className = 'status';

  try {
    const res = await fetch(`/api/lookup/${encodeURIComponent(dni)}`);
    const data = await res.json();

    if (data.found) {
      registroActual = data.registro;
      dniStatus.textContent = 'Encontrado';
      dniStatus.className = 'status found';
      mostrarVistaEncontrado(registroActual);
    } else {
      registroActual = null;
      dniStatus.textContent = 'No encontrado — completá los datos';
      dniStatus.className = 'status not-found';
      mostrarFormulario({ editando: false });
    }
  } catch (err) {
    dniStatus.textContent = 'Error al buscar';
    dniStatus.className = 'status not-found';
  }
}

btnEditar.addEventListener('click', () => {
  mostrarFormulario({ editando: true });
});

btnCancelar.addEventListener('click', () => {
  if (registroActual) {
    mostrarVistaEncontrado(registroActual);
  } else {
    ocultarTodo();
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formMessage.textContent = '';
  formMessage.className = 'message';

  const dni = dniInput.value.trim();
  if (!dni) {
    formMessage.textContent = 'Ingresá un DNI.';
    formMessage.className = 'message error';
    return;
  }

  const payload = {
    Fecha: fechaInput.value,
    DNI: dni,
    Nombre: nombreInput.value.trim(),
    Apellido: apellidoInput.value.trim(),
    FechaNacimiento: fechaNacimientoInput.value,
  };

  try {
    const res = await fetch('/api/registros', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Error al guardar');

    registroActual = data.registro;
    dniStatus.textContent = 'Encontrado';
    dniStatus.className = 'status found';
    mostrarVistaEncontrado(registroActual);
  } catch (err) {
    formMessage.textContent = err.message;
    formMessage.className = 'message error';
  }
});
