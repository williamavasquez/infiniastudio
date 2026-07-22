// Peru is UTC-5 year-round (no DST). Compute wall-clock Peru time from a
// UTC timestamp regardless of the host machine/server's own timezone.
function peruNow() {
  const peruMs = Date.now() - 5 * 60 * 60 * 1000;
  const d = new Date(peruMs);
  const fecha = d.toISOString().slice(0, 10);
  const hora = d.toISOString().slice(11, 19);
  const turno = d.getUTCHours() < 14 ? 'Mañana' : 'Tarde';
  return { fecha, hora, turno };
}

module.exports = { peruNow };
