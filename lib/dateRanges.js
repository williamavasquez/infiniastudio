const { peruNow } = require('./peruTime');

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return toISODate(d);
}

function startOfMonth(dateStr) {
  return `${dateStr.slice(0, 7)}-01`;
}

// Resuelve un preset de fecha a { desde, hasta } (strings "YYYY-MM-DD"),
// siempre en base al día de hoy en Perú (no en el timezone del navegador).
function resolveRange(preset, desde, hasta) {
  const hoy = peruNow().fecha;

  switch (preset) {
    case 'hoy':
      return { desde: hoy, hasta: hoy };
    case 'ayer': {
      const ayer = addDays(hoy, -1);
      return { desde: ayer, hasta: ayer };
    }
    case '7dias':
      return { desde: addDays(hoy, -6), hasta: hoy };
    case 'este_mes':
      return { desde: startOfMonth(hoy), hasta: hoy };
    case 'mes_anterior': {
      const ultimoDiaMesAnterior = addDays(startOfMonth(hoy), -1);
      return { desde: startOfMonth(ultimoDiaMesAnterior), hasta: ultimoDiaMesAnterior };
    }
    case 'rango':
      return { desde: desde || hoy, hasta: hasta || hoy };
    default:
      return { desde: hoy, hasta: hoy };
  }
}

module.exports = { resolveRange };
